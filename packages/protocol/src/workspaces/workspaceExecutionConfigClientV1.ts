import type { z } from 'zod';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import {
  compareWorkspaceWorkerPreferenceMutationV1, createDefaultWorkspaceWorkerPreferenceV1,
  projectWorkspaceWorkerPreferenceV1, workspaceWorkerPreferencesEqualV1,
  WorkspaceExecutionConfigAddressV1Schema, WorkspaceExecutionConfigRevisionV1Schema,
  WorkspaceExecutionSettingsV1Schema, WorkspaceWorkerPreferenceExpectationV1Schema, WorkspaceWorkerPreferenceV1Schema,
  type WorkspaceExecutionConfigAddressV1, type WorkspaceExecutionConfigRevisionV1, type WorkspaceExecutionSettingsV1,
  type WorkspaceWorkerPreferenceExpectationV1, type WorkspaceWorkerPreferenceV1,
  type WorkspaceWorkerPreferenceReadResultV1, type WorkspaceWorkerPreferenceMutationResultV1,
} from './projectWorkerPreferencesV1.js';
import {
  buildWorkspaceExecutionConfigRowIdV1, WORKSPACE_EXECUTION_CONFIG_ACCOUNT_SCOPED_BLOB_KIND_V1,
  StoredWorkspaceExecutionConfigContentV1Schema, StoredWorkspaceExecutionConfigPrivatePayloadV1Schema,
  WorkspaceExecutionConfigMutationRequestV1Schema, WorkspaceExecutionConfigMutationResponseV1Schema,
  WorkspaceExecutionConfigReadResponseV1Schema, WorkspaceExecutionConfigPrivatePayloadV1Schema,
  type WorkspaceExecutionConfigContentV1,
} from './workspaceExecutionConfigRowV1.js';
import { compareProjectServicePlacementMutationV1, createDefaultProjectServicePlacementV1,
  ProjectServicePlacementGetV1Schema, ProjectServicePlacementSetV1Schema,
  projectServicePlacementsEqualV1, readProjectServicePlacementEntryV1,
  type ProjectServicePlacementGetV1, type ProjectServicePlacementSetV1,
  type ProjectServicePlacementReadResultV1, type ProjectServicePlacementMutationResultV1,
} from './projectServicePlacementV1.js';

export type WorkspaceExecutionConfigTransportV1 = Readonly<{
  read(input: Readonly<{ address: WorkspaceExecutionConfigAddressV1 }>): Promise<unknown>;
  mutate(input: z.infer<typeof WorkspaceExecutionConfigMutationRequestV1Schema>): Promise<unknown>;
}>;

export class WorkspaceExecutionConfigContentErrorV1 extends Error {
  constructor(public readonly status: 'locked' | 'invalid') {
    super(`workspace_execution_config_${status}`);
    this.name = 'WorkspaceExecutionConfigContentErrorV1';
  }
}

/** Shared row codec: persisted Account mode chooses the envelope; the private row binding is verified after opening. */
export function openWorkspaceExecutionConfigContentV1(input: Readonly<{
  rowId: string; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown;
}>): WorkspaceExecutionSettingsV1 {
  const content = StoredWorkspaceExecutionConfigContentV1Schema.safeParse(input.content);
  if (!content.success || (input.mode === 'plain') !== (content.data.t === 'plain')) {
    throw new WorkspaceExecutionConfigContentErrorV1('invalid');
  }
  if (content.data.t === 'plain') return content.data.v;
  if (!input.material) throw new WorkspaceExecutionConfigContentErrorV1('locked');
  const opened = openAccountScopedBlobCiphertext({
    kind: WORKSPACE_EXECUTION_CONFIG_ACCOUNT_SCOPED_BLOB_KIND_V1, material: input.material, ciphertext: content.data.c,
  });
  const payload = StoredWorkspaceExecutionConfigPrivatePayloadV1Schema.safeParse(opened?.value);
  if (opened?.kindTag !== 'canonical' || !payload.success || payload.data.rowId !== input.rowId) {
    throw new WorkspaceExecutionConfigContentErrorV1('invalid');
  }
  return payload.data.value;
}

export function sealWorkspaceExecutionConfigContentV1(input: Readonly<{
  rowId: string; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  value: WorkspaceExecutionSettingsV1; randomBytes(length: number): Uint8Array;
}>): WorkspaceExecutionConfigContentV1 {
  const value = WorkspaceExecutionSettingsV1Schema.parse(input.value);
  if (input.mode === 'plain') return { t: 'plain', v: value };
  if (!input.material) throw new WorkspaceExecutionConfigContentErrorV1('locked');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
    kind: WORKSPACE_EXECUTION_CONFIG_ACCOUNT_SCOPED_BLOB_KIND_V1, material: input.material,
    payload: WorkspaceExecutionConfigPrivatePayloadV1Schema.parse({ rowId: input.rowId, value }), randomBytes: input.randomBytes,
  }) };
}

type Observation = Readonly<{ status: 'ready'; value: WorkspaceExecutionSettingsV1 | null; revision: WorkspaceExecutionConfigRevisionV1 }>
  | Readonly<{ status: 'locked' | 'invalid' | 'unavailable' | 'cancelled' }>;
type MutationInput = Readonly<{
  workspace: WorkspaceExecutionConfigAddressV1; expectedRevision: WorkspaceExecutionConfigRevisionV1;
  expected: WorkspaceWorkerPreferenceExpectationV1;
}>;

/** No cache or loader: both clients use this semantic operation at their captured Account/Home boundary. */
export function createWorkspaceExecutionConfigClientV1(options: Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; transport: WorkspaceExecutionConfigTransportV1;
  randomBytes(length: number): Uint8Array; isCurrent(): boolean | Promise<boolean>; signal?: AbortSignal;
}>) {
  const current = async () => !options.signal?.aborted && await options.isCurrent();
  const cryptoStatus = (): 'locked' | null => options.mode === 'e2ee' && !options.material ? 'locked' : null;
  const observationResult = (value: WorkspaceExecutionSettingsV1 | null, revision: WorkspaceExecutionConfigRevisionV1) => {
    const preference = value === null ? createDefaultWorkspaceWorkerPreferenceV1() : projectWorkspaceWorkerPreferenceV1(value);
    return { preference, revision, provenance: workspaceWorkerPreferencesEqualV1(preference, createDefaultWorkspaceWorkerPreferenceV1())
      ? 'default' as const : 'saved' as const };
  };
  async function observe(workspace: WorkspaceExecutionConfigAddressV1): Promise<Observation> {
    if (!await current()) return { status: 'cancelled' };
    if (cryptoStatus()) return { status: 'locked' };
    let raw: unknown;
    try { raw = await options.transport.read({ address: workspace }); }
    catch { return { status: await current() ? 'unavailable' : 'cancelled' }; }
    if (!await current()) return { status: 'cancelled' };
    const response = WorkspaceExecutionConfigReadResponseV1Schema.safeParse(raw);
    if (!response.success) return { status: 'invalid' };
    if (response.data.status === 'absent') return { status: 'ready', value: null, revision: 'absent' };
    if (response.data.status === 'deleted') return { status: 'ready', value: null, revision: response.data.revision };
    try {
      return { status: 'ready', revision: response.data.revision, value: openWorkspaceExecutionConfigContentV1({
        rowId: buildWorkspaceExecutionConfigRowIdV1(workspace), mode: options.mode, material: options.material, content: response.data.content,
      }) };
    } catch (error) {
      return { status: error instanceof WorkspaceExecutionConfigContentErrorV1 ? error.status : 'invalid' };
    }
  }
  async function get(input: Readonly<{ workspace: WorkspaceExecutionConfigAddressV1 }>): Promise<WorkspaceWorkerPreferenceReadResultV1> {
    const address = WorkspaceExecutionConfigAddressV1Schema.safeParse(input.workspace);
    if (!address.success) return { status: 'invalid' };
    const observed = await observe(address.data);
    if (observed.status !== 'ready') return { status: observed.status === 'cancelled' ? 'unavailable' : observed.status };
    return { status: 'ready', ...observationResult(observed.value, observed.revision) };
  }
  async function mutateRow<TObservation>(workspace: WorkspaceExecutionConfigAddressV1, semantic: Readonly<{
    compare(value: WorkspaceExecutionSettingsV1 | null): ReturnType<typeof compareWorkspaceWorkerPreferenceMutationV1>;
    satisfied(value: WorkspaceExecutionSettingsV1 | null): boolean;
    observation(value: WorkspaceExecutionSettingsV1 | null, revision: WorkspaceExecutionConfigRevisionV1): TObservation;
  }>): Promise<(TObservation & { status: 'applied' | 'satisfied' | 'unchanged' | 'conflict' })
    | { status: 'outcomeUnknown' | 'cancelled' | 'locked' | 'invalid' | 'unavailable' }> {
    const observeUnknown = async () => {
      const after = await observe(workspace);
      // This observation follows an issued write. Losing its captured lifetime
      // cannot prove nonacceptance, and cannot authorize a replacement read.
      if (after.status === 'cancelled') return { status: 'outcomeUnknown' as const };
      if (after.status === 'ready' && semantic.satisfied(after.value)) return { status: 'satisfied' as const, ...semantic.observation(after.value, after.revision) };
      return { status: 'outcomeUnknown' as const };
    };
    // Only an explicit CAS conflict is proof of nonacceptance and permits a rebase/write.
    while (await current()) {
      const observed = await observe(workspace);
      if (observed.status !== 'ready') return observed;
      const compared = semantic.compare(observed.value);
      if (compared.status !== 'apply') return { status: compared.status, ...semantic.observation(compared.value, observed.revision) };
      const content = sealWorkspaceExecutionConfigContentV1({
        rowId: buildWorkspaceExecutionConfigRowIdV1(workspace), mode: options.mode, material: options.material,
        value: compared.value, randomBytes: options.randomBytes,
      });
      if (!await current()) return { status: 'cancelled' };
      let raw: unknown;
      try {
        raw = await options.transport.mutate(WorkspaceExecutionConfigMutationRequestV1Schema.parse({ address: workspace, expectedRevision: observed.revision, content }));
      } catch {
        return await observeUnknown();
      }
      const response = WorkspaceExecutionConfigMutationResponseV1Schema.safeParse(raw);
      if (!response.success) return await observeUnknown();
      if (response.data.status === 'conflict') continue;
      // A validated receipt belongs to this invoker even if its lifetime has
      // retired. It is not publication into another Account's domain state.
      return { status: 'applied', ...semantic.observation(compared.value, response.data.revision) };
    }
    return { status: 'cancelled' };
  }
  async function mutate(input: MutationInput, next: WorkspaceWorkerPreferenceV1 | null): Promise<WorkspaceWorkerPreferenceMutationResultV1> {
    const address = WorkspaceExecutionConfigAddressV1Schema.safeParse(input.workspace);
    const expected = WorkspaceWorkerPreferenceExpectationV1Schema.safeParse(input.expected);
    const parsedNext = next === null ? null : WorkspaceWorkerPreferenceV1Schema.safeParse(next);
    if (!address.success || !expected.success || !WorkspaceExecutionConfigRevisionV1Schema.safeParse(input.expectedRevision).success
      || (parsedNext !== null && !parsedNext.success)) return { status: 'invalid' };
    const canonicalNext = parsedNext === null ? null : parsedNext.data;
    return await mutateRow(address.data, {
      compare: (value) => compareWorkspaceWorkerPreferenceMutationV1({ current: value, expected: expected.data, next: canonicalNext }),
      satisfied: (value) => workspaceWorkerPreferencesEqualV1(observationResult(value, 'absent').preference, canonicalNext ?? createDefaultWorkspaceWorkerPreferenceV1()),
      observation: observationResult,
    });
  }
  const serviceObservation = (value: WorkspaceExecutionSettingsV1 | null, revision: WorkspaceExecutionConfigRevisionV1, serviceName: string) => {
    const entry = readProjectServicePlacementEntryV1(value, serviceName);
    return { placement: entry ?? createDefaultProjectServicePlacementV1(), revision, provenance: entry === null ? 'default' as const : 'saved' as const };
  };
  async function getService(input: ProjectServicePlacementGetV1): Promise<ProjectServicePlacementReadResultV1> {
    const parsed = ProjectServicePlacementGetV1Schema.safeParse(input);
    if (!parsed.success) return { status: 'invalid' };
    const observed = await observe(parsed.data.workspace);
    if (observed.status !== 'ready') return { status: observed.status === 'cancelled' ? 'unavailable' : observed.status };
    return { status: 'ready', ...serviceObservation(observed.value, observed.revision, parsed.data.serviceName) };
  }
  async function setService(input: ProjectServicePlacementSetV1): Promise<ProjectServicePlacementMutationResultV1> {
    const parsed = ProjectServicePlacementSetV1Schema.safeParse(input);
    if (!parsed.success) return { status: 'invalid' };
    const intent = parsed.data;
    return await mutateRow(intent.workspace, {
      compare: (value) => compareProjectServicePlacementMutationV1({ current: value, serviceName: intent.serviceName, expected: intent.expected, value: intent.value }),
      satisfied: (value) => {
        const entry = readProjectServicePlacementEntryV1(value, intent.serviceName);
        return entry !== null && projectServicePlacementsEqualV1(entry, intent.value);
      },
      observation: (value, revision) => serviceObservation(value, revision, intent.serviceName),
    });
  }
  return {
    get, getService, setService,
    set: (input: MutationInput & Readonly<{ next: WorkspaceWorkerPreferenceV1 }>) => mutate(input, input.next),
    reset: (input: MutationInput) => mutate(input, null),
  };
}
