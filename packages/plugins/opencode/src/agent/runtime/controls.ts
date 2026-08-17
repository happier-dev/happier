import type {
  AgentSessionCatalogControl,
  AgentSessionContinuationControl,
  AgentSessionUsageLimitRecoveryControl,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { OPEN_CODE_USAGE_LIMIT_RECOVERY } from '../auth/services/usageLimit.js';

export type OpenCodeActiveSkillsReader = (
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown>;

export type OpenCodeActiveSkillsReaderRegistrar = (
  sessionId: string,
  reader: OpenCodeActiveSkillsReader,
) => Readonly<{ dispose(): void }>;

function diagnostic(code: string) {
  return { code, severity: 'error' as const };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const usageLimitRecovery: AgentSessionUsageLimitRecoveryControl = {
  async execute(request) {
    if (request.kind !== 'checkNow') {
      return {
        status: 'unsupported',
        diagnostic: diagnostic('opencode_reset_credit_unsupported'),
      };
    }
    return {
      status: 'waiting',
      retryAfterMs: OPEN_CODE_USAGE_LIMIT_RECOVERY.defaultFallbackBackoffMs,
    };
  },
};

const continuation: AgentSessionContinuationControl = {
  async verify() {
    return {
      status: 'unsupported',
      diagnostic: diagnostic('opencode_continuation_probe_unsupported'),
    };
  },
};

export function createOpenCodeNativeSessionControls() {
  const activeSkillsReaders = new Map<
    string,
    Readonly<{ reader: OpenCodeActiveSkillsReader }>
  >();
  const catalog: AgentSessionCatalogControl = {
    async list(request, context, options) {
      if (request.kind === 'vendorPlugins') {
        return {
          status: 'unsupported',
          diagnostic: diagnostic('opencode_vendor_catalog_unsupported'),
        };
      }
      const binding = activeSkillsReaders.get(context.session.id);
      if (context.session.activity !== 'active' || !binding) {
        return {
          status: 'unsupported',
          diagnostic: diagnostic('opencode_catalog_inactive_unsupported'),
        };
      }
      try {
        const rawSkills = await binding.reader(options);
        const items = (Array.isArray(rawSkills) ? rawSkills : []).flatMap((raw) => {
          const skill = record(raw);
          const name = string(skill?.name);
          if (!name) return [];
          const displayName = string(skill?.displayName) || name;
          const description = string(skill?.description);
          const path = string(skill?.path);
          return [{
            id: name,
            name,
            displayName,
            ...(description ? { description } : {}),
            ...(path ? { path } : {}),
            enabled: skill?.enabled !== false,
          }];
        });
        return { status: 'ok', kind: 'skills', items };
      } catch {
        return {
          status: 'unavailable',
          retryable: true,
          diagnostic: diagnostic('opencode_catalog_read_failed'),
        };
      }
    },
  };
  const bindActiveSkillsReader: OpenCodeActiveSkillsReaderRegistrar = (
    sessionId,
    reader,
  ) => {
    const binding = Object.freeze({ reader });
    activeSkillsReaders.set(sessionId, binding);
    let disposed = false;
    return Object.freeze({
      dispose() {
        if (disposed) return;
        disposed = true;
        if (activeSkillsReaders.get(sessionId) === binding) {
          activeSkillsReaders.delete(sessionId);
        }
      },
    });
  };
  return Object.freeze({
    sessions: Object.freeze({
      catalog,
      usageLimitRecovery,
      continuation,
    }),
    bindActiveSkillsReader,
  });
}
