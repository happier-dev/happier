import type { AcpProbeResult } from './acpProbe';
import { normalizeCapabilityProbeError } from '@/capabilities/utils/normalizeCapabilityProbeError';

type PromptCapabilitiesSnapshot = Readonly<{
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}>;

type McpCapabilitiesSnapshot = Readonly<{
  http: boolean;
  sse: boolean;
}>;

function normalizePromptCapabilities(raw: unknown): PromptCapabilitiesSnapshot {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    image: value.image === true,
    audio: value.audio === true,
    embeddedContext: value.embeddedContext === true,
  };
}

function normalizeMcpCapabilities(raw: unknown): McpCapabilitiesSnapshot {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    http: value.http === true,
    sse: value.sse === true,
  };
}

function normalizeSessionCapabilities(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function buildAcpCapabilitySnapshot(
  probe: AcpProbeResult,
):
  | Readonly<{
      ok: true;
      checkedAt: number;
      loadSession: boolean;
      agentCapabilities: Readonly<{
        loadSession: boolean;
        sessionCapabilities: Record<string, unknown>;
        promptCapabilities: PromptCapabilitiesSnapshot;
        mcpCapabilities: McpCapabilitiesSnapshot;
      }>;
    }>
  | Readonly<{
      ok: false;
      checkedAt: number;
      error: ReturnType<typeof normalizeCapabilityProbeError>;
    }> {
  if (!probe.ok) {
    return {
      ok: false,
      checkedAt: probe.checkedAt,
      error: normalizeCapabilityProbeError(probe.error),
    };
  }

  const capabilities = probe.agentCapabilities ?? {};
  const loadSession = capabilities.loadSession === true;
  return {
    ok: true,
    checkedAt: probe.checkedAt,
    loadSession,
    agentCapabilities: {
      loadSession,
      sessionCapabilities: normalizeSessionCapabilities((capabilities as any).sessionCapabilities),
      promptCapabilities: normalizePromptCapabilities((capabilities as any).promptCapabilities),
      mcpCapabilities: normalizeMcpCapabilities((capabilities as any).mcpCapabilities),
    },
  };
}
