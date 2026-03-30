import { rm, writeFile } from 'node:fs/promises';

type ProviderFailureReportV1 = {
  v: 1;
  providerId: string;
  scenarioId: string;
  error: string;
  ts: number;
};

export function formatProviderSkipWarning(params: { providerId: string; reason: string }): string {
  const cleaned = params.reason.replace(/\s+/g, ' ').trim();
  const compact = cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
  return `[providers] skipping ${params.providerId}: ${compact}`;
}

function providerFailureReportPathFromEnv(): string | null {
  const raw = (
    process.env.HAPPIER_E2E_PROVIDER_FAILURE_REPORT_PATH ??
    process.env.HAPPY_E2E_PROVIDER_FAILURE_REPORT_PATH ??
    ''
  ).trim();
  return raw.length > 0 ? raw : null;
}

export async function resetProviderFailureReport(): Promise<void> {
  const reportPath = providerFailureReportPathFromEnv();
  if (!reportPath) return;
  await rm(reportPath, { force: true }).catch(() => undefined);
}

export async function writeProviderFailureReport(params: {
  providerId: string;
  scenarioId: string;
  error: string;
}): Promise<void> {
  const reportPath = providerFailureReportPathFromEnv();
  if (!reportPath) return;
  const payload: ProviderFailureReportV1 = {
    v: 1,
    providerId: params.providerId,
    scenarioId: params.scenarioId,
    error: params.error,
    ts: Date.now(),
  };
  await writeFile(reportPath, JSON.stringify(payload, null, 2), 'utf8').catch(() => undefined);
}
