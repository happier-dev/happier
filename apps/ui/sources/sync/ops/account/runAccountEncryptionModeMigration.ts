import { canonicalSessionDraftAddressV2, isAccountOwnedDraftAddressV2, type SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { AccountEncryptionMigrateRequest, AccountEncryptionMigrateSuccessResponse } from '@happier-dev/protocol/account/encryptionMigrate';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

type Params = Readonly<{
  request: AccountEncryptionMigrateRequest;
  migrate(request: AccountEncryptionMigrateRequest): Promise<AccountEncryptionMigrateSuccessResponse>;
  activateTargetMode(): void | Promise<void>;
  acknowledgeSessionDrafts(records: readonly SessionDraftRecordV2[]): void | Promise<void>;
  isCurrent?(): boolean;
}>;

export async function runAccountEncryptionModeMigration(
  params: Params,
): Promise<AccountEncryptionMigrateSuccessResponse> {
  const result = await params.migrate(params.request);
  // A committed migration response remains authoritative, but a Home switch
  // retires local projection and acknowledgement. Do not turn that committed
  // result into a false failure or publish it into the newly selected Home.
  if (params.isCurrent && !params.isCurrent()) return result;
  if (result.mode !== params.request.toMode) {
    throw new Error('Invalid Account mode migration response');
  }
  for (const field of ['remoteHosts', 'notificationChannels', 'connectedPresentation', 'connectedAcknowledgements'] as const) {
    const expected = params.request[field];
    const row = result[field];
    if (expected === undefined ? row !== undefined : row === undefined
      || row.revision !== expected.expectedRevision + (expected.content === null ? 0 : 1)
      || !pluginJsonValuesEqual(row.content, expected.content)) {
      throw new Error('Account catalog migration response is incomplete or invalid');
    }
  }
  if (params.request.mcpServerCatalog) {
    const expected = params.request.mcpServerCatalog;
    const row = result.mcpServerCatalog;
    if (!row || row.revision !== expected.expectedRevision + (expected.content === null ? 0 : 1)
      || !pluginJsonValuesEqual(row.content, expected.content)) {
      throw new Error('MCP catalog migration response is incomplete or invalid');
    }
  }
  const expectedItems = params.request.sessionDrafts?.items ?? [];
  let migratedRecords: readonly SessionDraftRecordV2[] = [];

  if (params.request.sessionDrafts && "v" in params.request.sessionDrafts
    && (!result.sessionDrafts || !("v" in result.sessionDrafts)
      || result.sessionDrafts.v !== params.request.sessionDrafts.v)) {
    throw new Error('Invalid session draft migration response');
  }

  if (expectedItems.length > 0) {
    migratedRecords = result.sessionDrafts?.records ?? [];
    const expectedByAddress = new Map(expectedItems.map((item) => [
      canonicalSessionDraftAddressV2(item.address),
      item,
    ]));
    const responseAddresses = new Set<string>();
    const coverageIsExact = migratedRecords.length === expectedItems.length
      && migratedRecords.every((record) => {
        const canonicalAddress = canonicalSessionDraftAddressV2(record.address);
        const expected = expectedByAddress.get(canonicalAddress);
        if (!expected || responseAddresses.has(canonicalAddress)) return false;
        responseAddresses.add(canonicalAddress);
        return isAccountOwnedDraftAddressV2(record.address)
          && record.revision === expected.expectedRevision + 1
          && record.content !== null
          && pluginJsonValuesEqual(record.content, expected.content);
      });
    if (!coverageIsExact) {
      throw new Error('Invalid session draft migration response');
    }
  }

  const expectedMemory = params.request.authoringMemory?.items ?? [];
  if (params.request.acpCatalog) {
    const expected = params.request.acpCatalog;
    const row = result.acpCatalog?.row;
    if (!row || row.revision !== expected.expectedRevision + (expected.content === null ? 0 : 1)
      || !pluginJsonValuesEqual(row.content, expected.content)) {
      throw new Error('ACP catalog migration response is incomplete or invalid');
    }
  }
  if (params.request.providerConnections) {
    const expected = params.request.providerConnections;
    const row = result.providerConnections?.row;
    if (!row || row.revision !== expected.expectedRevision + (expected.content === null ? 0 : 1)
      || !pluginJsonValuesEqual(row.content, expected.content)) {
      throw new Error('Provider catalog migration response is incomplete or invalid');
    }
  }
  for (const key of ['connectedConfigurations', 'connectedPurposes'] as const) {
    const expected = params.request[key];
    if (!expected) continue;
    const row = result[key]?.row;
    if (!row || row.revision !== expected.expectedRevision + (expected.content === null ? 0 : 1)
      || !pluginJsonValuesEqual(row.content, expected.content)) {
      throw new Error('Connected catalog migration response is incomplete or invalid');
    }
  }
  if (params.request.promptLibrary) {
    const expected = params.request.promptLibrary.items;
    const rows = result.promptLibrary?.rows ?? [];
    const byKey = new Map(expected.map(item => [item.key, item]));
    const seen = new Set<string>();
    if (!result.promptLibrary || rows.length !== expected.length || !rows.every(row => {
      const item = byKey.get(row.key);
      if (!item || seen.has(row.key)) return false;
      seen.add(row.key);
      return row.revision === item.expectedRevision + 1 && row.content !== null
        && pluginJsonValuesEqual(row.content, item.content);
    })) throw new Error('Prompt catalog migration response is incomplete or invalid');
  }
  const expectedTrust = params.request.projectTrust?.items ?? [];
  if (expectedTrust.length > 0) {
    const rows = result.projectTrust?.rows ?? [];
    const identity = (project: Readonly<{ serverId: string; projectId: string }>) => JSON.stringify([project.serverId, project.projectId]);
    const expectedByProject = new Map(expectedTrust.map(item => [identity(item.project), item]));
    const seen = new Set<string>();
    if (rows.length !== expectedTrust.length || !rows.every(row => {
      const key = identity(row.project);
      const expected = expectedByProject.get(key);
      if (!expected || seen.has(key)) return false;
      seen.add(key);
      return row.revision === expected.expectedRevision + 1 && row.content !== null && pluginJsonValuesEqual(row.content, expected.content);
    })) throw new Error('Invalid Project Trust migration response');
  }
  if (expectedMemory.length > 0) {
    const rows = result.authoringMemory?.rows ?? [];
    const expectedByKey = new Map(expectedMemory.map((item) => [item.key, item]));
    const seen = new Set<string>();
    if (rows.length !== expectedMemory.length || !rows.every((row) => {
      const expected = expectedByKey.get(row.key);
      if (!expected || seen.has(row.key)) return false;
      seen.add(row.key);
      return row.revision === expected.expectedRevision + 1 && row.content !== null
        && pluginJsonValuesEqual(row.content, expected.content);
    })) throw new Error('Invalid authoring memory migration response');
  }

  if (params.request.profileRows) {
    const expectedItems = params.request.profileRows.items;
    const rows = result.profileRows?.rows ?? [];
    const expectedById = new Map(expectedItems.map((item) => [item.id, item]));
    const seen = new Set<string>();
    if (!result.profileRows
      || result.profileRows.referenceGuardRevision !== params.request.profileRows.expectedReferenceGuardRevision
      || rows.length !== expectedItems.length
      || !rows.every((row) => {
        const expected = expectedById.get(row.id);
        if (!expected || seen.has(row.id)) return false;
        seen.add(row.id);
        return row.revision === expected.expectedRevision + 1 && row.content !== null
          && pluginJsonValuesEqual(row.content, expected.content);
      })) throw new Error('Invalid Profile row migration response');
    const expectedControl = params.request.profileRows.transferControl;
    const returnedControl = result.profileRows.transferControl;
    const controlMatches = expectedControl.content !== null
      ? returnedControl.status === 'present'
        && expectedControl.expectedRevision !== 'absent'
        && returnedControl.revision === expectedControl.expectedRevision + 1
        && pluginJsonValuesEqual(returnedControl.content, expectedControl.content)
      : expectedControl.expectedRevision === 'absent'
        ? returnedControl.status === 'absent'
        : returnedControl.status === 'deleted' && returnedControl.revision === expectedControl.expectedRevision;
    if (!controlMatches) throw new Error('Invalid Profile transfer migration response');
  }

  const expectedExecutionConfig = params.request.workspaceExecutionConfig?.items ?? [];
  if (expectedExecutionConfig.length > 0) {
    const rows = result.workspaceExecutionConfig?.rows ?? [];
    const expectedByRowId = new Map(expectedExecutionConfig.map((item) => [item.rowId, item]));
    const seen = new Set<string>();
    if (rows.length !== expectedExecutionConfig.length || !rows.every((row) => {
      const expected = expectedByRowId.get(row.rowId);
      if (!expected || seen.has(row.rowId)) return false;
      seen.add(row.rowId);
      return row.revision === expected.expectedRevision + 1 && row.content !== null
        && pluginJsonValuesEqual(row.content, expected.content);
    })) throw new Error('Invalid workspace execution config migration response');
  }

  const expectedProjects = params.request.projectRows?.items ?? [];
  if (expectedProjects.length > 0) {
    const rows = result.projectRows?.rows ?? [];
    const expectedByKey = new Map(expectedProjects.map(item => [buildProjectAccountRowPhysicalKeyV1(item.key), item]));
    const seen = new Set<string>();
    if (rows.length !== expectedProjects.length || !rows.every(row => {
      const identity = buildProjectAccountRowPhysicalKeyV1(row.key);
      const expected = expectedByKey.get(identity);
      if (!expected || seen.has(identity)) return false;
      seen.add(identity);
      return row.revision === expected.expectedRevision + 1 && row.content !== null
        && pluginJsonValuesEqual(row.content, expected.content);
    })) throw new Error('Invalid Project row migration response');
  }

  await params.activateTargetMode();
  if (migratedRecords.length > 0) {
    await params.acknowledgeSessionDrafts(migratedRecords);
  }
  return result;
}
