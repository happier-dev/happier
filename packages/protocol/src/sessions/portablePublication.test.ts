import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import * as protocolRoot from '../index.js';
import * as generalSessions from './general.js';
import * as sessionSubagents from './subagents/index.js';
import * as sessionWorkState from './work/state/index.js';

const publicationCases = [
  {
    name: 'work state',
    entry: resolve(import.meta.dirname, './work/state/index.ts'),
    source: 'export * from ENTRY;',
  },
  {
    name: 'subagents',
    entry: resolve(import.meta.dirname, './subagents/index.ts'),
    source: 'export * from ENTRY;',
  },
  {
    name: 'General Sessions',
    entry: resolve(import.meta.dirname, './general.ts'),
    source: 'export * from ENTRY;',
  },
] as const;

async function bundledRealmClosure(testCase: (typeof publicationCases)[number]): Promise<Readonly<{
  moduleIds: readonly string[];
  nodeImports: readonly string[];
  browserExternalImporters: readonly string[];
}>> {
  const moduleIds = new Set<string>();
  const nodeImports = new Set<string>();
  const browserExternalImporters = new Set<string>();
  await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'protocol-portable-session-publication',
      resolveId(id, importer) {
        if (id.startsWith('node:')) {
          nodeImports.add(`${id} from ${importer ?? '<entry>'}`);
        }
        return id === 'virtual:protocol-portable-session-publication' ? `\0${id}` : null;
      },
      load(id) {
        if (id !== '\0virtual:protocol-portable-session-publication') return null;
        return testCase.source.replace('ENTRY', JSON.stringify(testCase.entry));
      },
      generateBundle() {
        for (const id of this.getModuleIds()) {
          moduleIds.add(id);
          if (id.includes('__vite-browser-external')) {
            for (const importer of this.getModuleInfo(id)?.importers ?? []) {
              browserExternalImporters.add(importer);
            }
          }
        }
      },
    }],
    build: {
      minify: false,
      target: 'es2022',
      write: false,
      rollupOptions: {
        input: 'virtual:protocol-portable-session-publication',
        preserveEntrySignatures: 'strict',
        output: {
          format: 'es',
          inlineDynamicImports: true,
        },
      },
    },
  });
  return {
    moduleIds: [...moduleIds],
    nodeImports: [...nodeImports],
    browserExternalImporters: [...browserExternalImporters],
  };
}

describe('portable Protocol Session publication owners', () => {
  it('preserves the existing Protocol root export identities', () => {
    expect(sessionWorkState.boundSessionWorkStateItemsV1)
      .toBe(protocolRoot.boundSessionWorkStateItemsV1);
    expect(sessionWorkState.ACTIVITY_SESSION_SYSTEM_RECORD_KINDS)
      .toBe(protocolRoot.ACTIVITY_SESSION_SYSTEM_RECORD_KINDS);
    expect(sessionWorkState.SessionWorkflowRunSnapshotV1Schema)
      .toBe(protocolRoot.SessionWorkflowRunSnapshotV1Schema);
    expect(sessionSubagents.parseParticipantMessageV1)
      .toBe(protocolRoot.parseParticipantMessageV1);
    expect(sessionSubagents.parseSubagentCommandV1)
      .toBe(protocolRoot.parseSubagentCommandV1);
    expect(sessionSubagents.parseSubagentLaunchV1)
      .toBe(protocolRoot.parseSubagentLaunchV1);
    expect(generalSessions.SPAWN_SESSION_ERROR_CODES)
      .toBe(protocolRoot.SPAWN_SESSION_ERROR_CODES);
    expect(generalSessions.SessionRuntimeIssueV1Schema)
      .toBe(protocolRoot.SessionRuntimeIssueV1Schema);
    expect(generalSessions.materializeRecipientOperationRequestV1)
      .toBe(protocolRoot.materializeRecipientOperationRequestV1);
    expect('SecretStringV1Schema' in generalSessions).toBe(false);
    expect('registerSensitiveDiagnosticValues' in generalSessions).toBe(false);
    expect('zodSchemaToJsonSchemaObject' in generalSessions).toBe(false);
  });

  for (const testCase of publicationCases) {
    it(`keeps the ${testCase.name} projection outside Node-only and marketplace modules`, async () => {
      const closure = await bundledRealmClosure(testCase);
      expect({
        nodeImports: closure.nodeImports,
        browserExternalImporters: closure.browserExternalImporters,
        forbiddenModuleIds: closure.moduleIds.filter((id) => (
          id.includes('__vite-browser-external')
          || id.startsWith('node:')
          || id.includes('/marketplace/marketplaceSourceRegistryV1')
        )),
      }).toEqual({ nodeImports: [], browserExternalImporters: [], forbiddenModuleIds: [] });
    }, 60_000);
  }
});
