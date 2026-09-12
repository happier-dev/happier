import { describe, expect, it } from 'vitest';

import {
  evaluateExistingSessionAutomationEligibility,
  resolveConfiguredAcpSessionResume,
} from './existingSessionAutomationPolicy.js';

const configuredBackend = {
  id: 'custom-backend',
  name: 'custom-backend',
  title: 'Custom backend',
  command: 'custom-agent',
  args: [],
  env: {},
  transportProfile: 'generic' as const,
  capabilities: {
    supportsLoadSession: true,
    supportsModes: 'unknown' as const,
    supportsModels: 'unknown' as const,
    supportsConfigOptions: 'unknown' as const,
    promptImageSupport: 'unknown' as const,
  },
  createdAt: 1,
  updatedAt: 1,
};

describe('resolveConfiguredAcpSessionResume', () => {
  it('returns the exact configured target and provider session id only when metadata and catalog agree', () => {
    const metadata = {
      flavor: 'acp:misleading-flavor',
      acpConfiguredBackendV1: {
        v: 1,
        updatedAt: 1,
        backendId: 'custom-backend',
        title: 'Custom backend',
      },
      customAcpSessionId: ' provider-session-1 ',
    };
    const accountSettings = {
      acpCatalogSettingsV1: { v: 2 as const, backends: [configuredBackend] },
      backendEnabledByTargetKey: { 'acpBackend:custom-backend': true },
    };

    expect(resolveConfiguredAcpSessionResume({ metadata, accountSettings })).toEqual({
      eligible: true,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' },
      vendorResumeId: 'provider-session-1',
    });
    expect(resolveConfiguredAcpSessionResume({
      metadata: {
        ...metadata,
        acpConfiguredBackendV1: { ...metadata.acpConfiguredBackendV1, backendId: 'other-backend' },
      },
      accountSettings,
    })).toEqual({ eligible: false, reasonCode: 'agent_unsupported' });
  });
});

describe('evaluateExistingSessionAutomationEligibility', () => {
  it('accepts vendor-resumable sessions with a persisted resume id', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          flavor: 'claude',
          claudeSessionId: 'claude-session-1',
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'claude',
      strategy: 'vendor_resume',
    });
  });

  it('accepts Pi sessions with a persisted resume id', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          flavor: 'pi',
          piSessionId: 'pi-session-1',
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'pi',
      strategy: 'vendor_resume',
    });
  });

  it('accepts configured ACP sessions only when exact identity and static load policy agree', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          flavor: 'acp:custom-backend',
          acpConfiguredBackendV1: {
            v: 1,
            updatedAt: 1,
            backendId: 'custom-backend',
            title: 'Custom backend',
          },
          customAcpSessionId: 'provider-session-1',
        },
        accountSettings: {
          acpCatalogSettingsV1: {
            v: 2,
            backends: [{
              id: 'custom-backend',
              name: 'custom-backend',
              title: 'Custom backend',
              command: 'custom-agent',
              args: [],
              env: {},
              transportProfile: 'generic',
              capabilities: {
                supportsLoadSession: true,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
              },
              createdAt: 1,
              updatedAt: 1,
            }],
          },
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'customAcp',
      strategy: 'vendor_resume',
    });
  });

  it('rejects configured ACP flavor-only, undeclared, disabled, and id-less sessions', () => {
    expect(evaluateExistingSessionAutomationEligibility({
      metadata: { flavor: 'acp:custom-backend', customAcpSessionId: 'provider-session-1' },
    })).toEqual({ eligible: false, reasonCode: 'agent_unknown' });

    const metadata = {
      acpConfiguredBackendV1: {
        v: 1,
        updatedAt: 1,
        backendId: 'custom-backend',
        title: 'Custom backend',
      },
      customAcpSessionId: 'provider-session-1',
    };
    const backend = {
      id: 'custom-backend',
      name: 'custom-backend',
      title: 'Custom backend',
      command: 'custom-agent',
      args: [],
      env: {},
      transportProfile: 'generic',
      capabilities: {
        supportsLoadSession: false,
        supportsModes: 'unknown',
        supportsModels: 'unknown',
        supportsConfigOptions: 'unknown',
        promptImageSupport: 'unknown',
      },
      createdAt: 1,
      updatedAt: 1,
    };

    expect(evaluateExistingSessionAutomationEligibility({ metadata })).toEqual({ eligible: false, reasonCode: 'agent_unsupported' });
    expect(evaluateExistingSessionAutomationEligibility({
      metadata,
      accountSettings: { acpCatalogSettingsV1: { v: 2, backends: [backend] } },
    })).toEqual({ eligible: false, reasonCode: 'agent_unsupported' });
    expect(evaluateExistingSessionAutomationEligibility({
      metadata: { ...metadata, customAcpSessionId: ' ' },
      accountSettings: {
        acpCatalogSettingsV1: {
          v: 2,
          backends: [{ ...backend, capabilities: { ...backend.capabilities, supportsLoadSession: true } }],
        },
      },
    })).toEqual({ eligible: false, reasonCode: 'vendor_resume_id_missing' });
  });

  it('accepts runtime-descriptor sessions without legacy top-level vendor ids', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'opencode',
            provider: { backendMode: 'server', vendorSessionId: 'opencode-session-1' },
          },
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'opencode',
      strategy: 'vendor_resume',
    });
  });
});
