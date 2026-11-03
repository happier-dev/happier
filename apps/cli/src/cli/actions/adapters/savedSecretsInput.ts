import { writeInputPath } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { readMissingActionSecretInputPaths } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { Buffer } from 'node:buffer';
import type { ActionExecuteResult, ActionId } from '@happier-dev/protocol';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { parseSavedSecretPasskeyImportV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { promptInput, isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { normalizeActionExecuteResult, unwrapCliActionSuccessPayload } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { isApprovalRequestCreatedResult, type ApprovalRequestCreatedResult } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import type { ActionCliFailure } from '../commandPresentation';

type SecretInputDeclaration = Parameters<typeof readMissingActionSecretInputPaths>[0];
type Input = Readonly<Record<string, unknown>>;
type ReadAction = (actionId: ActionId, input: Input) => Promise<ActionExecuteResult>;

/** The Action failed before a mutation; retain its typed outcome at the CLI boundary. */
export class SavedSecretsInputFailure extends Error {
  constructor(readonly failure: ActionCliFailure) {
    super(failure.errorMessage ?? failure.errorCode);
  }
}

export class SavedSecretsInputReadApproval extends Error {
  constructor(readonly result: ApprovalRequestCreatedResult) {
    super('Metadata read requires approval.');
  }
}

function invalid(message: string): never {
  throw new SavedSecretsInputFailure({ errorCode: 'invalid_arguments', errorMessage: message });
}

export function needsSavedSecretsInputPreparation(actionId: string): boolean {
  return actionId === 'secrets.create' || actionId === 'secrets.update' || actionId === 'secrets.delete'
    || actionId === 'registries.sources.create' || actionId === 'registries.sources.token.set';
}

export function isPrivateSecretCliWrite(actionId: string): boolean {
  return actionId === 'secrets.create' || actionId === 'secrets.update' || actionId === 'secrets.delete';
}

async function readMetadata(execute: ReadAction, actionId: ActionId): Promise<unknown> {
  const result = normalizeActionExecuteResult(await execute(actionId, {}));
  if (!result.ok) throw new SavedSecretsInputFailure(result);
  const payload = unwrapCliActionSuccessPayload(result.data);
  if (isApprovalRequestCreatedResult(payload)) throw new SavedSecretsInputReadApproval(payload);
  return payload;
}

function selectUnique<T>(matches: readonly T[], label: string): T {
  if (matches.length === 0) invalid(`${label} was not found in this Home.`);
  if (matches.length > 1) invalid(`${label} is ambiguous. Use its id.`);
  return matches[0]!;
}

/** An exact private-resource identity always wins over a display-name match. */
export function matchPersonalSavedSecretMetadata<T extends Readonly<{ secretId: string; name: string }>>(
  entries: readonly T[], identifier: unknown,
): readonly T[] {
  const ids = entries.filter(secret => secret.secretId === identifier);
  return ids.length ? ids : entries.filter(secret => secret.name === identifier);
}

/** Read bytes once, keep whitespace, and remove only the shell's final line ending. */
async function readSecretValue(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new SavedSecretsInputFailure({ errorCode: 'cancelled' });
  let value: string;
  if (process.stdin.isTTY) {
    if (!isInteractiveTerminal()) invalid('Provide the secret value through stdin.');
    try { value = await promptInput('Secret value: ', { secret: true, ...(signal ? { signal } : {}) }); }
    catch (error) {
      if (signal?.aborted) throw new SavedSecretsInputFailure({ errorCode: 'cancelled' });
      throw error;
    }
  } else {
    const input = process.stdin;
    const chunks: Buffer[] = [];
    value = await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        input.removeListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onData = (chunk: string | Uint8Array) => chunks.push(Buffer.from(chunk));
      const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '')); };
      const onError = () => { cleanup(); reject(new SavedSecretsInputFailure({ errorCode: 'invalid_arguments', errorMessage: 'Could not read the secret value from stdin.' })); };
      const onAbort = () => { cleanup(); input.pause(); reject(new SavedSecretsInputFailure({ errorCode: 'cancelled' })); };
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else if (input.readableEnded) onEnd();
    });
  }
  if (value.length === 0) invalid('The secret value must not be empty.');
  return value;
}

async function resolveSecretRef(execute: ReadAction, identifier: string): Promise<string> {
  const parsed = SharedSavedSecretListOutputV1Schema.safeParse(await readMetadata(execute, 'secrets.shared.list'));
  if (!parsed.success) invalid('Saved Secret metadata is unavailable.');
  const entries = parsed.data.resources.filter(entry => 'ref' in entry);
  const identities = entries.filter(entry => {
    if (entry.ref === identifier) return true;
    try {
      const ref = parseSavedSecretRefV1(entry.ref);
      return (ref.kind === 'shared_resource' ? ref.resourceId : ref.personalId) === identifier;
    } catch { return false; }
  });
  const entry = selectUnique(identities.length ? identities : entries.filter(entry => entry.name === identifier), 'Saved Secret');
  if (!entry.capabilities.use) invalid('This Saved Secret cannot be used.');
  if(parseSavedSecretRefV1(entry.ref).kind!=='shared_resource')invalid('Import this Saved Secret into the current private resource catalog before binding it.');
  return entry.ref;
}

/** Prepare through the authenticated executor; no Settings writer or secret materializer belongs here. */
export async function prepareSavedSecretsCliInput(params: Readonly<{
  actionId: string; input: Input; execute: ReadAction; signal?: AbortSignal; secretInput?: SecretInputDeclaration;
}>): Promise<Input> {
  const { actionId, input, execute } = params;
  if (!needsSavedSecretsInputPreparation(actionId)) {
    let prepared = input;
    for (const path of readMissingActionSecretInputPaths(params.secretInput ?? {}, input)) {
      prepared = writeInputPath(prepared, path, await readSecretValue(params.signal));
    }
    return prepared;
  }
  if (actionId === 'secrets.create') {
    const { passkeyFormat, ...ordinaryInput } = input;
    if (input.source !== undefined) {
      if (passkeyFormat !== undefined) invalid('Choose one source or import format.');
      return ordinaryInput;
    }
    const value = await readSecretValue(params.signal);
    if (passkeyFormat === undefined) return { ...ordinaryInput, value };
    let exported: unknown;
    try { exported = JSON.parse(value); }
    catch { throw new SavedSecretsInputFailure({ errorCode: 'input_invalid' }); }
    const parsed = parseSavedSecretPasskeyImportV1({ format: passkeyFormat, value: exported });
    if (parsed.status !== 'ready') throw new SavedSecretsInputFailure({ errorCode: parsed.status });
    return { ...ordinaryInput, kind: 'other', source: parsed.source };
  }
  if (actionId === 'secrets.update' || actionId === 'secrets.delete') {
    const parsed = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.list'].safeParse(await readMetadata(execute, 'secrets.list'));
    if (!parsed.success) invalid('Saved Secret metadata is unavailable.');
    const secret = selectUnique(matchPersonalSavedSecretMetadata(parsed.data.secrets, input.secretId), 'Saved Secret');
    const resolved = { secretId: secret.secretId, expectedUpdatedAt: secret.updatedAt };
    if (actionId === 'secrets.delete') return resolved;
    if (input.source !== undefined) return { ...resolved, source: input.source,
      ...(typeof input.rename === 'string' ? { name: input.rename } : {}) };
    return typeof input.rename === 'string'
      ? { ...resolved, name: input.rename }
      : { ...resolved, value: await readSecretValue(params.signal) };
  }
  const { tokenSecret, secret, clear, npmProfile, clearNpmProfile, ...ordinaryInput } = input;
  const canonical: Record<string, unknown> = ordinaryInput;
  const tokenIdentifier = actionId === 'registries.sources.create' ? tokenSecret : secret;
  if (typeof tokenIdentifier === 'string') canonical.token = { secretRef: await resolveSecretRef(execute, tokenIdentifier) };
  else if (clear === true) canonical.token = null;
  if (typeof npmProfile === 'string') canonical.npmRegistryProfileId = npmProfile;
  else if (clearNpmProfile === true) canonical.npmRegistryProfileId = null;
  if (actionId === 'registries.sources.token.set') {
    const parsed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].safeParse(await readMetadata(execute, 'registries.sources.list'));
    if (!parsed.success) invalid('Registry source metadata is unavailable.');
    const ids = parsed.data.sources.filter(source => source.id === input.sourceId);
    const source = selectUnique(ids.length ? ids : parsed.data.sources.filter(source => source.title === input.sourceId), 'Registry source');
    canonical.sourceId = source.id;
  }
  return canonical;
}
