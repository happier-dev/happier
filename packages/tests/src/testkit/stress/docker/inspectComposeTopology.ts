import type { ComposeRuntime } from './composeRuntime';

type ComposePsEntry = Readonly<{
  Service?: string;
  State?: string;
}>;

export type ComposeTopologySnapshot = Readonly<{
  services: string[];
  resolvedApiReplicas: number;
  resolvedWorkerReplicas: number;
  ports: Record<string, number | undefined>;
}>;

function parseComposePsOutput(raw: string): ComposePsEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as ComposePsEntry[];
  }
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComposePsEntry);
}

export async function inspectComposeTopology(params: {
  runtime: ComposeRuntime;
  expectedPorts: Record<string, number | undefined>;
}): Promise<ComposeTopologySnapshot> {
  const entries = parseComposePsOutput(await params.runtime.ps());
  const services = [...new Set(entries.map((entry) => entry.Service).filter((value): value is string => typeof value === 'string'))];

  const resolvedApiReplicas = entries.filter((entry) => entry.Service === 'api' && entry.State === 'running').length;
  const resolvedWorkerReplicas = entries.filter((entry) => entry.Service === 'worker' && entry.State === 'running').length;

  return {
    services,
    resolvedApiReplicas,
    resolvedWorkerReplicas,
    ports: params.expectedPorts,
  };
}
