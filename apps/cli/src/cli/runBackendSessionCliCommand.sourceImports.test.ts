import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('Agent runner command import demand', () => {
  it('projects connected-account compatibility without importing its API transport', async () => {
    const source = await readFile(new URL('../plugins/projection/registry/connectedAccountPurposeCompatibility.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('connectedAccountPurposeCompatibility.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const eagerTransports = file.statements.filter(statement => (
      ts.isImportDeclaration(statement)
      && !statement.importClause?.isTypeOnly
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === '@/api/client/qualifiedConnectedAccountApi'
    ));
    expect(eagerTransports).toHaveLength(0);
  });

  it('loads generation custody retirement only when registry reconciliation consumes it', async () => {
    const source = await readFile(new URL('../plugins/store/registry/currentState.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('currentState.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const eagerRetirement = file.statements.filter(statement => (
      ts.isImportDeclaration(statement)
      && !statement.importClause?.isTypeOnly
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === './generationCustodyRetirement'
    ));
    expect(eagerRetirement).toHaveLength(0);
  });

  it('loads signed-root Action control only when a request consumes it', async () => {
    const source = await readFile(new URL('../daemon/controlClient.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('controlClient.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const eagerControls = file.statements.filter(statement => (
      ts.isImportDeclaration(statement)
      && !statement.importClause?.isTypeOnly
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === './externalActions/signedRootActionControl'
    ));
    expect(eagerControls).toHaveLength(0);
  });

  it('enumerates launch environment keys without evaluating the protected authoring-origin reader', async () => {
    const source = await readFile(new URL('../session/runtime/control/sessionControlEnvironment.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('sessionControlEnvironment.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const eagerReaders = file.statements.filter(statement => (
      ts.isImportDeclaration(statement)
      && !statement.importClause?.isTypeOnly
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === '@/session/shared/sessionCreateAuthoringOrigin'
    ));
    expect(eagerReaders).toHaveLength(0);

    const { HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_ENV_KEY, readSessionCreateAuthoringOriginFromEnv } = await import('../session/shared/sessionCreateAuthoringOrigin');
    const env = { [HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_ENV_KEY]: '{}' };
    expect(() => readSessionCreateAuthoringOriginFromEnv(env)).toThrow();
    expect(env).not.toHaveProperty(HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_ENV_KEY);
  });

  it('keeps Agent parsing and catalog projection from evaluating the root catalog', async () => {
    const eagerAgentCatalogs: string[] = [];
    for (const path of ['./sessionStartArgs.ts', './providerSessionArgPartition.ts', '../plugins/projection/registry/agentCatalogEntryHooks.ts', '../agent/catalog/ids.ts']) {
      const source = await readFile(new URL(path, import.meta.url), 'utf8');
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement)
          && !statement.importClause?.isTypeOnly
          && ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text === '@happier-dev/agents') {
          eagerAgentCatalogs.push(path);
        }
      }
    }
    expect(eagerAgentCatalogs).toHaveLength(0);
  });

  it('loads no Settings, Profile, foreground-admission, Session runtime or failure presenter before command entry', async () => {
    const source = await readFile(new URL('./runBackendSessionCliCommand.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('runBackendSessionCliCommand.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const deferredOwners = new Set([
      '@happier-dev/protocol/profiles/read',
      '@/ui/auth',
      '@/cli/providerCliPassthrough',
      '@/session/services/spawnConnectedServicesDefaults',
      '@/settings/accountSettings/bootstrapAccountSettingsContext',
      '@/settings/profiles/buildProfileEnvOverlay',
      '@/settings/profiles/readProfilesFromAccountSettings',
      '@/settings/profiles/resolveProfileForAgent',
      '@/providers/settings/hydrate',
      '@/daemon/ensureDaemon',
      '@/daemon/controlClient',
      '@/agent/runtime/bridges/session/SessionHostBridge',
      '@/cli/connectedServices/resolveDirectCliConnectedServiceBindings',
      '@/session/runtime/catalogHooks',
      './resolveSessionRunnerFailureExitCode',
    ]);
    const eagerOwners = file.statements.flatMap(statement => (
      ts.isImportDeclaration(statement)
        && !statement.importClause?.isTypeOnly
        && ts.isStringLiteral(statement.moduleSpecifier)
        && deferredOwners.has(statement.moduleSpecifier.text)
        ? [statement.moduleSpecifier.text] : []
    ));
    // This measures real startup roots, including unused imports that bundling
    // may retain for module side effects. Each owner loads at its first consumer.
    expect(eagerOwners).toHaveLength(0);
  });
});
