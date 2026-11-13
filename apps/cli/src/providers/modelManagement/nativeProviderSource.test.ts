import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { createTeamCredentialNativeSourceServices } from './nativeProviderSource';

describe('Team credential native source failures', () => {
  it('retains the Home transport cause during native launch preparation', async () => {
    const failureCause = { phase: 'provider.source_read', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    const services = createTeamCredentialNativeSourceServices({ machineId: 'machine', isFeatureEnabled: () => true,
      context: { controllerAccountId: 'controller', readResource: async () => {
        throw Object.assign(new Error('private Home diagnostic'), { failureCause });
      } },
      getAccountSettingsSnapshot: () => null,
      acquireRuntimeLease: async () => { throw new Error('Resource must be admitted before acquiring a runtime'); },
      projectSourceModels: async () => { throw new Error('Resource must be admitted before projecting models'); },
    });
    await expect(services.prepare({ machineId: 'machine', agentTargetKey: 'agent:happier.agent.codex/codex',
      sourceCatalog: true, providerConnection: { connectionId: ProviderConnectionIdSchema.parse('pc_source'),
        expectedConnectionSecurityFingerprint: 'connection-security:v1:source' },
      nativeSource: { resourceId: 'resource', expectedResourceRevision: 1 },
    })).resolves.toMatchObject({ ok: false, error: { code: 'provider_authorization_changed', failureCause } });
  });
});
