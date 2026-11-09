import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

describe('SessionHostBridge import demand', () => {
  it('loads attach, handoff, fork, external-link and hook owners only when their operations run', async () => {
    const source = await readFile(new URL('./SessionHostBridge.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('SessionHostBridge.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const operationOwners = new Set([
      '@/session/attach/evaluateCliSessionAttachEligibility',
      '@/session/handoff/resolveSessionHandoffEligibility',
      '@/session/fork/backendTarget',
      './externalSessionSourceCanonicalization',
      '@/agent/runtime/bridges/_shared/emitBridgeLifecycleHookEventBestEffort',
    ]);
    const eagerOperationOwners = file.statements.flatMap(statement => (
      ts.isImportDeclaration(statement)
        && !statement.importClause?.isTypeOnly
        && ts.isStringLiteral(statement.moduleSpecifier)
        && operationOwners.has(statement.moduleSpecifier.text)
        ? [statement.moduleSpecifier.text] : []
    ));
    expect(eagerOperationOwners).toHaveLength(0);

    // Deferring an operation preserves its real admission decision on use.
    const { SessionHostBridge } = await import('./SessionHostBridge');
    await expect(new SessionHostBridge().evaluateAttachEligibility({
      credentials: { token: 'archived-session-token', encryption: null },
      rawSession: createSessionRecordFixture({ id: 'archived-session', archivedAt: 1 }),
      accountEncryptionMode: 'e2ee',
      currentMachineId: null,
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({ eligible: false, reasonCode: 'archived' });
  });
});
