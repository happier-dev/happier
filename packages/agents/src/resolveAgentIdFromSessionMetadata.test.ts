import { describe, expect, it } from 'vitest';

import {
  resolveAgentIdFromSessionMetadata,
  resolveAgentExecutionTargetFromSessionMetadata,
  resolveSessionMetadataAgentIdentity,
} from './resolveAgentIdFromSessionMetadata.js';
import { readNonAuthoritativeLinkedExternalSessionV1FromMetadata } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { buildCommittedLaunchMetadata } from './session/state/metadataWriters.js';
import { projectCurrentAgentSessionView } from './session/state/projectCurrentAgentSessionView.js';

function runtimeDescriptor(agentId: string) {
  return { v: 1, agentId, agent: {} };
}

describe('resolveSessionMetadataAgentIdentity', () => {
  it.each([
    { agentId: 'pi', identity: { pluginId: 'happier.agent.pi', localId: 'pi' } },
    { agentId: 'example.agents/reviewer', identity: { pluginId: 'example.agents', localId: 'reviewer' } },
  ])('resolves the current $agentId target after cutover without rewriting birth provenance', ({ agentId, identity }) => {
    const birth = buildSessionCreationCorrespondence({
      identity: { callerCreationNamespace: 'user', creationKey: 'continued-session' },
      recipe: { execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/tmp' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } } },
    });
    const initial = buildCommittedLaunchMetadata({ options: { sessionCreationCorrespondence: birth }, directory: '/tmp' });
    const continued = projectCurrentAgentSessionView(initial, { agentId, agentScopedCurrentState: 'clear' });

    expect(resolveAgentIdFromSessionMetadata(continued)).toBe(agentId);
    expect(resolveAgentExecutionTargetFromSessionMetadata(continued)).toEqual({ kind: 'agent', identity });
    expect(continued.sessionCreationCorrespondenceV1).toEqual(birth);
  });

  it.each([
    { identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, agentId: 'codex' },
    { identity: { pluginId: 'example.agents', localId: 'codex' }, agentId: 'example.agents/codex' },
    { identity: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' }, agentId: 'ohMyPi' },
  ])('resolves a committed unlaunched birth through its exact selected contribution ($agentId)', ({ identity, agentId }) => {
    const agentTarget = { kind: 'agent' as const, identity };
    const metadata = buildCommittedLaunchMetadata({ options: {
      sessionCreationCorrespondence: buildSessionCreationCorrespondence({
        identity: { callerCreationNamespace: 'user', creationKey: 'template-copy' },
        recipe: { execution: { machineId: 'b-owned-e3b5', directory: { kind: 'path', path: '/tmp' } },
          organization: { folderId: null, tagIds: [] }, agentTarget },
      }),
    }, directory: '/tmp' });
    expect(metadata.machineId).toBe('b-owned-e3b5');
    expect(resolveAgentIdFromSessionMetadata(metadata)).toBe(agentId);
    expect(resolveSessionMetadataAgentIdentity(metadata).basis).toBe('birth');
    expect(resolveAgentExecutionTargetFromSessionMetadata(metadata)).toEqual(agentTarget);
    expect(resolveAgentIdFromSessionMetadata({ ...metadata, runtimeDescriptorV1: runtimeDescriptor('claude') })).toBe('claude');
    expect(resolveAgentIdFromSessionMetadata({ ...metadata, flavor: 'claude' })).toBe('claude');
    expect(resolveAgentIdFromSessionMetadata({ ...metadata, claudeSessionId: 'current-claude' })).toBe('claude');
    expect(resolveAgentIdFromSessionMetadata({ ...metadata, flavor: 'acp:review-bot',
      acpConfiguredBackendV1: { v: 1, backendId: 'review-bot', title: 'Review Bot', updatedAt: 2 } })).toBeNull();
  });

  it('prefers the declared runtime descriptor over flavor and flat resume keys', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      runtimeDescriptorV1: runtimeDescriptor('codex'),
      flavor: 'claude',
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
    });

    expect(identity.agentId).toBe('codex');
    expect(identity.basis).toBe('declared');
    expect(identity.ambiguousVendorResumeKeys).toBe(false);
  });

  it('prefers flavor over flat resume keys when no identity is declared', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      flavor: 'codex',
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
    });

    expect(identity.agentId).toBe('codex');
    expect(identity.basis).toBe('flavor');
    expect(identity.ambiguousVendorResumeKeys).toBe(false);
  });

  it('infers identity from exactly one flat resume key', () => {
    const identity = resolveSessionMetadataAgentIdentity({ claudeSessionId: 'claude-1' });

    expect(identity.agentId).toBe('claude');
    expect(identity.basis).toBe('vendorResumeKey');
    expect(identity.vendorResumeKeyAgentIds).toEqual(['claude']);
  });

  it('fails closed when two flat resume keys exist without higher authority', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
    });

    expect(identity.agentId).toBeNull();
    expect(identity.basis).toBe('none');
    expect(identity.ambiguousVendorResumeKeys).toBe(true);
    expect([...identity.vendorResumeKeyAgentIds].sort()).toEqual(['claude', 'codex']);
  });

  it('ignores blank flat resume keys when counting evidence', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      claudeSessionId: '   ',
      codexSessionId: 'codex-1',
    });

    expect(identity.agentId).toBe('codex');
    expect(identity.basis).toBe('vendorResumeKey');
    expect(identity.ambiguousVendorResumeKeys).toBe(false);
  });

  it('reports unknown identity for metadata with no Agent evidence', () => {
    const identity = resolveSessionMetadataAgentIdentity({ path: '/tmp/project' });

    expect(identity.agentId).toBeNull();
    expect(identity.basis).toBe('none');
    expect(identity.ambiguousVendorResumeKeys).toBe(false);
    expect(identity.vendorResumeKeyAgentIds).toEqual([]);
  });
});

describe('resolveAgentIdFromSessionMetadata', () => {
  it('reuses a caller-admitted linked identity without reopening raw metadata and keeps null distinct from absent', () => {
    const raw = { v: 1, agentId: 'codex', machineId: 'machine-1', remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' } };
    const admitted = readNonAuthoritativeLinkedExternalSessionV1FromMetadata({ externalSessionV1: raw });
    expect(admitted).not.toBeNull();
    let reads = 0;
    const metadata = { flavor: 'claude', get externalSessionV1() { reads += 1; return raw; } };
    expect(resolveAgentIdFromSessionMetadata(metadata, admitted)).toBe('codex');
    expect(reads).toBe(0);
    expect(resolveAgentExecutionTargetFromSessionMetadata(metadata, undefined, admitted)?.identity)
      .toEqual({ pluginId: 'happier.agent.codex', localId: 'codex' });
    expect(reads).toBe(0);
    expect(resolveAgentIdFromSessionMetadata(metadata)).toBe('codex');
    expect(reads).toBeGreaterThan(0);
    expect(resolveAgentIdFromSessionMetadata({ flavor: 'claude', externalSessionV1: 'invalid' }, null)).toBe('claude');
    expect(resolveAgentIdFromSessionMetadata({ runtimeDescriptorV1: runtimeDescriptor('claude') }, admitted)).toBe('claude');
  });
  it('does not silently pick the first catalog Agent when two flat resume keys are present', () => {
    expect(resolveAgentIdFromSessionMetadata({
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
    })).toBeNull();
  });

  it('still resolves a single-key Session', () => {
    expect(resolveAgentIdFromSessionMetadata({ codexSessionId: 'codex-1' })).toBe('codex');
  });

  it('resolves a declared Session that also carries a stale foreign resume key', () => {
    expect(resolveAgentIdFromSessionMetadata({
      runtimeDescriptorV1: runtimeDescriptor('codex'),
      claudeSessionId: 'stale-claude',
    })).toBe('codex');
  });

  it('preserves an installed external Agent declared by the runtime descriptor', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      runtimeDescriptorV1: runtimeDescriptor('acme.agent'),
      flavor: 'claude',
      claudeSessionId: 'stale-claude',
    });

    expect(identity).toMatchObject({
      agentId: 'acme.agent',
      basis: 'declared',
      ambiguousVendorResumeKeys: false,
    });
    expect(resolveAgentIdFromSessionMetadata({
      runtimeDescriptorV1: runtimeDescriptor('acme.agent'),
    })).toBe('acme.agent');
  });
});
