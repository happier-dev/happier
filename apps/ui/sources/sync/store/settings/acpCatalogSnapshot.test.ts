import { describe, expect, it } from 'vitest';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';

import { createDraftAcpBackend } from '@/components/settings/acpCatalog/createDraftAcpBackend';
import {
  applyAcknowledgedAcpCatalog,
  getAcpCatalogSnapshot,
} from './acpCatalogSnapshot';

const scope = { serverId: 'server-marks', accountId: 'account-marks' };
const iconUrl =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/devin.svg';

describe('ACP catalog brand marks', () => {
  it('draws an agent added from the ACP Registry in theme ink and a command agent as supplied', () => {
    const blank = createDraftAcpBackend();
        const draft = { ...blank, launch: { kind: 'command' as const, command: 'agent', args: [] } };
    const registryAgent = AcpBackendDefinitionV1Schema.parse({
      ...draft,
      id: 'registry-acp-devin',
      name: 'registry-acp-devin',
      title: 'Devin',
      origin: {
        kind: 'registry',
        iconUrl,
        provenance: {
          sourceId: 'builtin:acp-registry',
          format: 'acp-registry',
          sourceUrl:
            'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
          itemId: 'devin',
          ref: { kind: 'version', version: '3000.12.43' },
          importedAt: 1,
        },
      },
    });
    const commandAgent = AcpBackendDefinitionV1Schema.parse({
      ...draft,
      id: 'kiro',
      name: 'kiro',
      title: 'Kiro',
    });
    applyAcknowledgedAcpCatalog(
      scope,
      { v: 1, definitions: [registryAgent, commandAgent] },
      1,
      true,
    );
    const marks = getAcpCatalogSnapshot(scope)?.brandMarks;
    expect(marks?.['registry-acp-devin']).toEqual({
      displayName: 'Devin',
      light: { uri: iconUrl },
      monochrome: true,
    });
    expect(marks?.kiro).toEqual({ displayName: 'Kiro' });
  });
});
