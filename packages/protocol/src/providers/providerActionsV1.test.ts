import { describe, expect, it } from 'vitest';
import { parseProviderActionRequestV1 } from './providerActionsV1.js';

describe('personal experimental confirmation Action', () => {
  it('retains personal confirmation and rejects the retired Team mutation subject', () => {
    const input = { action: 'confirmExperimental', machineId: 'machine', connectionId: 'gateway',
      expectedConnectionRevision: 1, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model',
      compatibilityFingerprint: 'compatibility:v1:reviewed' };
    expect(parseProviderActionRequestV1('providers.models.experimental.confirm', input).input).toEqual(input);
    expect(() => parseProviderActionRequestV1('providers.models.experimental.confirm', { ...input,
      subject: { kind: 'team_resource', teamId: 'team', resourceId: 'resource', expectedRevision: 0,
        sourceRevision: 'source-current', deliveryMode: 'brokered', application: {
          agentTargetKey: input.agentTargetKey, implementationIdentity: { pluginId: 'acme.gateway', localId: 'gateway' },
          endpointTemplateId: 'responses', protocol: 'openai-responses',
        } },
    })).toThrow();
  });
});
