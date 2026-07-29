const EXPECTED_ERROR_CODES = Object.freeze({
  operationDenied: 'plugin_host_access_operation_denied',
  resourceNotSelected: 'plugin_host_access_resource_not_selected',
  undeclaredPurpose: 'plugin_connected_account_purpose_undeclared',
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
  assertExactKeys(binding, ['purpose', 'service', 'target'], `${purpose} binding`);
  assertExactKeys(binding.service, ['pluginId', 'localId'], `${purpose} service`);
  assertExactKeys(binding.target, ['kind', 'displayName'], `${purpose} target`);
  assert(binding.purpose === purpose, `${purpose} binding returned purpose '${String(binding.purpose)}'`);
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

  await accounts.requestSelection({ purpose: 'group', reason: 'Select the group' });
  const events = [];
  const subscription = accounts.watch('group', (event) => {
    assertResync(event);
    events.push(event);
  });
  await delayTurn();
  assert(events.length === 1, `watch initial resync count was ${events.length}`);
  const firstGroup = await accounts.materialize('group', {
    kind: 'environment',
    keys: ['GROUP_TOKEN'],
  });
  assert(firstGroup.kind === 'environment', 'group materialization returned the wrong kind');
  assert(firstGroup.env.GROUP_TOKEN === 'packed-group-alpha-secret', 'group did not initially resolve alpha');
  await delayTurn();
  assert(events.length === 2, `change during rematerialization produced ${events.length} total resyncs`);
  const secondGroup = await accounts.materialize('group', {
    kind: 'environment',
    keys: ['GROUP_TOKEN'],
  });
  assert(secondGroup.kind === 'environment', 'second group materialization returned the wrong kind');
  assert(secondGroup.env.GROUP_TOKEN === 'packed-group-beta-secret', 'group did not resolve the current member');
  const countAtDispose = events.length;
  subscription.dispose();
  await accounts.requestSelection({ purpose: 'group', reason: 'Change after watch disposal' });
  await delayTurn();
  assert(events.length === countAtDispose, 'disposed watch received another event');

  const firstReplacement = await accounts.requestSelection({
    purpose: 'replaceable',
    reason: 'Select the first replaceable account',
  });
  const secondReplacement = await accounts.requestSelection({
    purpose: 'replaceable',
    reason: 'Replace the selected account',
  });
  assert(
    firstReplacement.target.displayName !== secondReplacement.target.displayName,
    'binding replacement did not change the public target',
  );
  const replacement = await accounts.materialize('replaceable', {
    kind: 'environment',
    keys: ['REPLACEABLE_TOKEN'],
  });
  assert(
    replacement.kind === 'environment' && replacement.env.REPLACEABLE_TOKEN === 'packed-replacement-two-secret',
    'replacement did not affect later materialization',
  );

  await accounts.requestSelection({ purpose: 'revocable', reason: 'Select the revocable account' });
  const revocationEvents = [];
  const revocationSubscription = accounts.watch('revocable', (event) => {
    assertResync(event);
    revocationEvents.push(event);
  });
  await delayTurn();
  const revokedSnapshot = await accounts.materialize('revocable', {
    kind: 'environment',
    keys: ['REVOCABLE_TOKEN'],
  });
  assert(
    revokedSnapshot.kind === 'environment' && revokedSnapshot.env.REVOCABLE_TOKEN === 'packed-revocable-secret',
    'revocable snapshot was not materialized',
  );
  await delayTurn();
  assert(revocationEvents.length === 2, 'revocation did not invalidate the watch');
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
    fixedKinds: [headers.kind, environment.kind, files.kind],
    groupChanged: firstGroup.env.GROUP_TOKEN !== secondGroup.env.GROUP_TOKEN,
    replacementObserved: firstReplacement.target.displayName !== secondReplacement.target.displayName,
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
    service: binding.service,
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

function createConformanceProducerRuntime(displayName) {
  return {
    authentication: {
      modes: {
        manual: {
          kind: 'manual',
          async complete() {
            return {
              status: 'connected',
              displayName,
              scopes: [],
            };
          },
        },
      },
    },
    async refresh() {
      return {
        status: 'connected',
        displayName,
        scopes: [],
      };
    },
    async revoke() {
      return { status: 'remoteUnsupported' };
    },
    async status() {
      return {
        status: 'connected',
        displayName,
        scopes: [],
      };
    },
    async materialize(request) {
      if (request.kind === 'httpHeaders') {
        return { kind: 'httpHeaders', headers: {} };
      }
      if (request.kind === 'environment') {
        return { kind: 'environment', env: {} };
      }
      return { kind: 'files', files: {} };
    },
  };
}

export async function activate(api) {
  api.connectedAccounts.register(
    'vault',
    createConformanceProducerRuntime('Acme Vault conformance account'),
  );
  api.connectedAccounts.register(
    'archive',
    createConformanceProducerRuntime('Acme Archive conformance account'),
  );
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
