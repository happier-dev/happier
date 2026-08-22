import { describe, expect, it } from 'vitest';

import { resolveSessionActionDefaultBackend } from './resolveSessionActionDefaultBackend';

	describe('resolveSessionActionDefaultBackend', () => {
	  it('returns configured ACP backend targets from session metadata while keeping a built-in fallback id', () => {
	    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'customAcp',
          acpConfiguredBackendV1: {
            v: 1,
            updatedAt: 1,
            backendId: 'acp-backend',
            title: 'Review Bot',
          },
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
      fallbackAgentId: 'claude',
	    });

	    expect(resolved).toEqual({
	      backendTarget: {
	        kind: 'backend',
	        backendId: 'acp-backend',
	        configuredBackendId: 'acp-backend',
	        sourceKind: 'configured',
	      },
	      defaultBackendId: 'claude',
	      displayAgentType: 'claude',
	    });
	  });

  it('keeps the concrete configured backend target while exposing canonical built-in session defaults for configured ACP sessions', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'customAcp',
          agent: 'customAcp',
          acpConfiguredBackendV1: {
            v: 1,
            updatedAt: 1,
            backendId: 'review-bot',
            title: 'Review Bot',
          },
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
      fallbackAgentId: 'claude',
	    });

	    expect(resolved).toEqual({
	      backendTarget: {
	        kind: 'backend',
	        backendId: 'review-bot',
	        configuredBackendId: 'review-bot',
	        sourceKind: 'configured',
	      },
	      defaultBackendId: 'claude',
	      displayAgentType: 'claude',
	    });
	  });

  it('falls back to the inferred built-in agent when no configured ACP backend metadata exists', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'codex',
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
	    });

	    expect(resolved).toEqual({
	      backendTarget: { kind: 'backend', backendId: 'codex' },
	      defaultBackendId: 'codex',
	      displayAgentType: 'codex',
	    });
	  });

  it('treats a built-in metadata.agent as the default built-in target when no enabled-agent filter is provided', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          agent: 'codex',
        },
      } as any,
	    });

	    expect(resolved).toEqual({
	      backendTarget: { kind: 'backend', backendId: 'codex' },
	      defaultBackendId: 'codex',
	      displayAgentType: 'codex',
	    });
	  });

  it('preserves raw metadata.agent for id-based review defaults while keeping a built-in target', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'claude',
          agent: 'coderabbit',
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
	    });

	    expect(resolved).toEqual({
	      backendTarget: { kind: 'backend', backendId: 'claude' },
	      defaultBackendId: 'coderabbit',
	      displayAgentType: 'claude',
	    });
	  });

  it('does not synthesize a built-in target from a non built-in metadata.agent without another built-in signal', () => {
    expect(resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          agent: 'acme.review-bot',
        },
      } as any,
    })).toBeNull();
  });

  it('fails closed for an external runtime descriptor when resolving a built-in default', () => {
    expect(resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.agent',
            provider: {},
          },
        },
      } as any,
    })).toBeNull();
  });

  it('does not replace an external runtime owner with the first enabled built-in backend', () => {
    expect(resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.review-bot',
            provider: {},
          },
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
    })).toBeNull();
  });

  it('returns null when no explicit backend or built-in agent signal exists', () => {
    expect(resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {},
      } as any,
      enabledAgentIds: [],
    })).toBeNull();
  });
});
