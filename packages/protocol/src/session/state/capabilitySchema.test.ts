import { describe, expect, it } from 'vitest';

import {
  CapabilitiesSchema,
  SessionStateCapabilitiesV1Schema,
  SESSION_STATE_FIELD_IDS,
} from '../../index.js';

describe('SessionStateCapabilitiesV1Schema', () => {
  it('rejects unknown session state field ids', () => {
    const parsed = SessionStateCapabilitiesV1Schema.safeParse({
      display: {
        title: { supported: true },
        subtitle: { supported: true },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects unknown session state field families', () => {
    const parsed = SessionStateCapabilitiesV1Schema.safeParse({
      arbitrary: {
        field: { supported: true },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('defaults missing provider directions to unsupported', () => {
    const parsed = SessionStateCapabilitiesV1Schema.parse({
      display: {
        title: { supported: true },
      },
    });

    expect(parsed.display?.title?.happierToProvider).toEqual({ supported: false });
    expect(parsed.display?.title?.providerToHappier).toEqual({ supported: false });
  });

  it('publishes the closed V1 field id catalog', () => {
    expect(SESSION_STATE_FIELD_IDS).toEqual([
      'identity.runtimeDescriptor',
      'identity.providerSessionId',
      'intent.model',
      'intent.permissionMode',
      'intent.acpSessionMode',
      'intent.acpConfigOption',
      'display.title',
      'runtime.workState',
      'runtime.usageLimitRecovery',
      'view.readState',
      'view.attention',
    ]);
  });

  it('accepts usage-limit recovery capabilities in the closed schema', () => {
    const parsed = SessionStateCapabilitiesV1Schema.parse({
      runtime: {
        usageLimitRecovery: {
          supported: true,
          providerToHappier: { supported: true, source: 'event' },
        },
      },
    });

    expect(parsed.runtime?.usageLimitRecovery?.providerToHappier).toEqual({
      supported: true,
      source: 'event',
    });
  });

  it('embeds the schema at capabilities.session.state', () => {
    const parsed = CapabilitiesSchema.parse({
      session: {
        state: {
          display: {
            title: { supported: true },
          },
        },
      },
    });

    expect(parsed.session.state.display?.title?.happierToProvider).toEqual({ supported: false });
  });
});
