const EXPECTED_ERROR_CODES = Object.freeze({
  operationDenied: 'plugin_host_access_operation_denied',
  resourceNotSelected: 'plugin_host_access_resource_not_selected',
  undeclaredPurpose: 'plugin_connected_account_purpose_undeclared',
  bindingOutOfScope: 'plugin_connected_account_binding_out_of_scope',
});

function assert(condition, message) {
  if (!condition) throw new Error(`Connected Accounts conformance failed: ${message}`);
}

async function expectErrorCode(run, code, label) {
  try {
    await run();
  } catch (error) {
    assert(error?.code === code, `${label} returned '${String(error?.code)}' instead of '${code}'`);
    return;
  }
  throw new Error(`Connected Accounts conformance failed: ${label} unexpectedly succeeded`);
}

function assertExactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} is not an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} exposed keys ${JSON.stringify(actual)}`);
}

function assertBinding(binding, purpose, targetKind) {
  assertExactKeys(binding, ['purpose', 'service', 'account', 'target'], `${purpose} binding`);
  assertExactKeys(binding.service, ['pluginId', 'localId'], `${purpose} service`);
  assertExactKeys(binding.account, ['service', 'accountId'], `${purpose} account`);
  assertExactKeys(binding.account.service, ['pluginId', 'localId'], `${purpose} account service`);
  assertExactKeys(binding.target, ['kind', 'displayName'], `${purpose} target`);
  assert(binding.purpose === purpose, `${purpose} binding returned purpose '${String(binding.purpose)}'`);
  assert(
    binding.service.pluginId === binding.account.service.pluginId
      && binding.service.localId === binding.account.service.localId,
    `${purpose} binding account did not retain the selected service`,
  );
  assert(typeof binding.account.accountId === 'string' && binding.account.accountId.length > 0, `${purpose} binding omitted its exact account id`);
  assert(binding.target.kind === targetKind, `${purpose} target was not '${targetKind}'`);
}

function assertResync(event) {
  assertExactKeys(event, ['kind'], 'watch event');
  assert(event.kind === 'resync', `watch event kind was '${String(event.kind)}'`);
}

function delayTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function runInitialConformance(accounts, logger) {
  assert(await accounts.getBinding('fixed') === null, 'unbound fixed purpose did not return null');
  await expectErrorCode(
    () => accounts.getBinding('undeclared'),
    EXPECTED_ERROR_CODES.undeclaredPurpose,
    'undeclared purpose',
  );
  await expectErrorCode(
    () => accounts.materialize('fixed', { kind: 'environment', keys: ['FIXED_TOKEN'] }),
    EXPECTED_ERROR_CODES.resourceNotSelected,
    'unselected materialization',
  );

  await accounts.requestSelection({ purpose: 'select-only', reason: 'Select for permission conformance' });
  await expectErrorCode(
    () => accounts.getBinding('select-only'),
    EXPECTED_ERROR_CODES.operationDenied,
    'selection-only getBinding',
  );
  await expectErrorCode(
    () => Promise.resolve(accounts.watch('select-only', () => {})),
    EXPECTED_ERROR_CODES.operationDenied,
    'selection-only watch',
  );
  assert(await accounts.getBinding('use-only') === null, 'use-only purpose did not permit getBinding');
  await expectErrorCode(
    () => accounts.requestSelection({ purpose: 'use-only', reason: 'Must be rejected' }),
    EXPECTED_ERROR_CODES.operationDenied,
    'use-only requestSelection',
  );

  const fixedBinding = await accounts.requestSelection({
    purpose: 'fixed',
    reason: 'Select the fixed conformance account',
  });
  assertBinding(fixedBinding, 'fixed', 'account');
  const expectedFixed = await accounts.materialize('fixed', {
    kind: 'environment',
    keys: ['FIXED_TOKEN'],
  }, {
    expectedAccount: fixedBinding.account,
  });
  assert(
    expectedFixed.kind === 'environment' && expectedFixed.env.FIXED_TOKEN === 'packed-environment-secret',
    'expected account did not materialize the current fixed binding',
  );
  const headers = await accounts.materialize('fixed', {
    kind: 'httpHeaders',
    origin: 'https://api.example.test',
    headerNames: ['authorization'],
  });
  assertExactKeys(headers, ['kind', 'headers'], 'header materialization');
  assert(headers.kind === 'httpHeaders', 'header materialization returned the wrong kind');
  assertExactKeys(headers.headers, ['authorization'], 'materialized headers');
  assert(headers.headers.authorization === 'Bearer packed-header-secret', 'header secret was not materialized');

  const environment = await accounts.materialize('fixed', {
    kind: 'environment',
    keys: ['FIXED_TOKEN'],
  });
  assertExactKeys(environment, ['kind', 'env'], 'environment materialization');
  assert(environment.kind === 'environment', 'environment materialization returned the wrong kind');
  assertExactKeys(environment.env, ['FIXED_TOKEN'], 'materialized environment');
  assert(environment.env.FIXED_TOKEN === 'packed-environment-secret', 'environment secret was not materialized');

  const files = await accounts.materialize('fixed', {
    kind: 'files',
    fileIds: ['credential'],
  });
  assertExactKeys(files, ['kind', 'files'], 'file materialization');
  assert(files.kind === 'files', 'file materialization returned the wrong kind');
  assertExactKeys(files.files, ['credential'], 'materialized files');
  const fileSecret = new TextDecoder().decode(files.files.credential);
  assert(fileSecret === 'packed-file-secret', 'file secret was not materialized');
  logger.info(`redaction ${headers.headers.authorization} ${environment.env.FIXED_TOKEN} ${fileSecret}`);

  const multiBinding = await accounts.requestSelection({
    purpose: 'multi',
    reason: 'Select exactly one compatible service',
  });
  assertBinding(multiBinding, 'multi', 'account');
  assert(
    multiBinding.service.localId === 'archive',
    'multi-service purpose did not bind exactly the host-selected alternate service',
  );

  const groupBinding = await accounts.requestSelection({ purpose: 'group', reason: 'Select the group' });
  assertBinding(groupBinding, 'group', 'group');
  assert(groupBinding.account.accountId === 'alpha', 'group binding did not expose its initial exact account');
  const events = [];
  const subscription = accounts.watch('group', (event) => {
    assertResync(event);
    events.push(event);
  });
  await delayTurn();
  assert(events.length === 1, `watch initial resync count was ${events.length}`);
  await expectErrorCode(
    () => accounts.materialize('group', {
      kind: 'environment',
      keys: ['GROUP_TOKEN'],
    }),
    EXPECTED_ERROR_CODES.resourceNotSelected,
    'group materialization after its current member changed',
  );
  await delayTurn();
  assert(events.length === 2, `change during rematerialization produced ${events.length} total resyncs`);
  const secondGroup = await accounts.materialize('group', {
    kind: 'environment',
    keys: ['GROUP_TOKEN'],
  });
  assert(secondGroup.kind === 'environment', 'second group materialization returned the wrong kind');
  assert(secondGroup.env.GROUP_TOKEN === 'packed-group-beta-secret', 'group did not resolve the current member');
  const currentGroupBinding = await accounts.getBinding('group');
  assert(currentGroupBinding !== null, 'group binding was lost after member replacement');
  assertBinding(currentGroupBinding, 'group', 'group');
  assert(currentGroupBinding.account.accountId === 'beta', 'group binding did not refresh its exact account');
  const countAtDispose = events.length;
  subscription.dispose();
  await accounts.requestSelection({ purpose: 'group', reason: 'Change after watch disposal' });
  await delayTurn();
  assert(events.length === countAtDispose, 'disposed watch received another event');

  const firstReplacement = await accounts.requestSelection({
    purpose: 'replaceable',
    reason: 'Select the first replaceable account',
  });
  assertBinding(firstReplacement, 'replaceable', 'account');
  const secondReplacement = await accounts.requestSelection({
    purpose: 'replaceable',
    reason: 'Replace the selected account',
  });
  assertBinding(secondReplacement, 'replaceable', 'account');
  assert(
    firstReplacement.target.displayName !== secondReplacement.target.displayName,
    'binding replacement did not change the public target',
  );
  const expectedCurrentReplacement = await accounts.materialize('replaceable', {
    kind: 'environment',
    keys: ['REPLACEABLE_TOKEN'],
  }, {
    expectedAccount: secondReplacement.account,
  });
  assert(
    expectedCurrentReplacement.kind === 'environment'
      && expectedCurrentReplacement.env.REPLACEABLE_TOKEN === 'packed-replacement-two-secret',
    'expected account did not compare against the current replacement binding',
  );
  await expectErrorCode(
    () => accounts.materialize('replaceable', {
      kind: 'environment',
      keys: ['REPLACEABLE_TOKEN'],
    }, {
      expectedAccount: firstReplacement.account,
    }),
    EXPECTED_ERROR_CODES.resourceNotSelected,
    'superseded expected account materialization',
  );
  const replacement = await accounts.materialize('replaceable', {
    kind: 'environment',
    keys: ['REPLACEABLE_TOKEN'],
  });
  assert(
    replacement.kind === 'environment' && replacement.env.REPLACEABLE_TOKEN === 'packed-replacement-two-secret',
    'replacement did not affect later materialization',
  );

  const revocableBinding = await accounts.requestSelection({
    purpose: 'revocable',
    reason: 'Select the revocable account',
  });
  assertBinding(revocableBinding, 'revocable', 'account');
  const revocationEvents = [];
  const revocationSubscription = accounts.watch('revocable', (event) => {
    assertResync(event);
    revocationEvents.push(event);
  });
  await delayTurn();
  await expectErrorCode(
    () => accounts.materialize('revocable', {
      kind: 'environment',
      keys: ['REVOCABLE_TOKEN'],
    }, {
      expectedAccount: revocableBinding.account,
    }),
    EXPECTED_ERROR_CODES.resourceNotSelected,
    'expected account materialization after revocation during await',
  );
  await delayTurn();
  assert(
    revocationEvents.length >= 2,
    `revocation did not invalidate the watch (received ${revocationEvents.length} total resyncs)`,
  );
  await expectErrorCode(
    () => accounts.materialize('revocable', { kind: 'environment', keys: ['REVOCABLE_TOKEN'] }),
    EXPECTED_ERROR_CODES.resourceNotSelected,
    'revoked materialization',
  );
  revocationSubscription.dispose();

  await accounts.requestSelection({ purpose: 'rotating', reason: 'Select the rotating materializer' });
  const rotatingEvents = [];
  const rotatingSubscription = accounts.watch('rotating', (event) => {
    assertResync(event);
    rotatingEvents.push(event);
  });
  await delayTurn();
  const rotatingOne = await accounts.materialize('rotating', {
    kind: 'environment',
    keys: ['ROTATING_TOKEN'],
  });
  await delayTurn();
  const rotatingTwo = await accounts.materialize('rotating', {
    kind: 'environment',
    keys: ['ROTATING_TOKEN'],
  });
  assert(
    rotatingOne.kind === 'environment'
      && rotatingOne.env.ROTATING_TOKEN === 'packed-materializer-one-secret'
      && rotatingTwo.kind === 'environment'
      && rotatingTwo.env.ROTATING_TOKEN === 'packed-materializer-two-secret',
    'materializer replacement did not change the authoritative snapshot',
  );
  assert(rotatingEvents.length === 2, 'materializer replacement did not invalidate the watch');
  rotatingSubscription.dispose();

  return {
    phase: 'initial',
    noEnumeration: typeof accounts.list === 'undefined',
    binding: fixedBinding,
    fixedKinds: [headers.kind, environment.kind, files.kind],
    groupCurrentnessRejected: true,
    replacementObserved: firstReplacement.target.displayName !== secondReplacement.target.displayName,
    expectedAccountMatchedCurrentBinding: true,
    expectedAccountRejectedSupersededBinding: true,
    expectedAccountRevalidatedAfterMaterialization: true,
    revocationObserved: true,
    materializerChanged: rotatingOne.env.ROTATING_TOKEN !== rotatingTwo.env.ROTATING_TOKEN,
  };
}

async function runRestartConformance(accounts) {
  const binding = await accounts.getBinding('fixed');
  assert(binding !== null, 'durable fixed selection did not survive consumer generation replacement');
  assertBinding(binding, 'fixed', 'account');
  const materialized = await accounts.materialize('fixed', {
    kind: 'environment',
    keys: ['FIXED_TOKEN'],
  });
  assert(
    materialized.kind === 'environment' && materialized.env.FIXED_TOKEN === 'packed-environment-secret',
    'replacement generation did not independently rematerialize the durable selection',
  );
  const events = [];
  const subscription = accounts.watch('fixed', (event) => {
    assertResync(event);
    events.push(event);
  });
  await delayTurn();
  subscription.dispose();
  assert(events.length === 1, 'replacement invocation did not receive one initial opaque resync');
  return {
    phase: 'replacement-generation',
    binding,
    durableSelection: true,
    rematerialized: true,
    watchWasNonDurable: true,
  };
}

async function runRemovalReaddConformance(accounts) {
  assert(
    await accounts.getBinding('fixed') === null,
    'removed durable fixed selection resurrected after purpose re-add',
  );
  await expectErrorCode(
    () => accounts.materialize('fixed', { kind: 'environment', keys: ['FIXED_TOKEN'] }),
    EXPECTED_ERROR_CODES.resourceNotSelected,
    're-added purpose materialization before reselection',
  );
  await accounts.requestSelection({
    purpose: 'fixed',
    reason: 'Reselect after removal and re-add',
  });
  const materialized = await accounts.materialize('fixed', {
    kind: 'environment',
    keys: ['FIXED_TOKEN'],
  });
  assert(
    materialized.kind === 'environment'
      && materialized.env.FIXED_TOKEN === 'packed-environment-secret',
    're-added purpose did not rematerialize after explicit reselection',
  );
  return {
    phase: 'removal-readd',
    durableSelectionWasAbsent: true,
    rematerializedAfterReselection: true,
  };
}

export async function activate(api) {
  api.actions.register('verify', async (_input, context) => {
    const accounts = context.services.connectedAccounts;
    assert(typeof accounts?.getBinding === 'function', 'connectedAccounts.getBinding is unavailable');
    assert(typeof accounts?.requestSelection === 'function', 'connectedAccounts.requestSelection is unavailable');
    assert(typeof accounts?.materialize === 'function', 'connectedAccounts.materialize is unavailable');
    assert(typeof accounts?.watch === 'function', 'connectedAccounts.watch is unavailable');
    assert(typeof accounts.list === 'undefined', 'connectedAccounts exposed account enumeration');

    const fixed = await accounts.getBinding('fixed');
    return fixed === null
      ? await runInitialConformance(accounts, context.services.logger)
      : await runRestartConformance(accounts);
  });
  api.actions.register('verify-removal-readd', async (_input, context) => {
    const accounts = context.services.connectedAccounts;
    assert(typeof accounts?.getBinding === 'function', 'connectedAccounts.getBinding is unavailable');
    assert(typeof accounts?.requestSelection === 'function', 'connectedAccounts.requestSelection is unavailable');
    assert(typeof accounts?.materialize === 'function', 'connectedAccounts.materialize is unavailable');
    return await runRemovalReaddConformance(accounts);
  });
}
