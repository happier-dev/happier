import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { DiagnosticsActionInputSchemas, DiagnosticsActionOutputSchemas } from '../diagnosticsActionFamily.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from '../actionSpecs.js';

const diagnosticRead = {
  safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, agent: true, mcp: true, cli: true, rpc: false, voice: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only', cli: 'discoverable_only' },
  inputHints: { fields: [] },
} as const;
type DiagnosticsActionSpec = {
  [Id in keyof typeof DiagnosticsActionInputSchemas]: ActionSpecProjectionMetadata & typeof diagnosticRead & Readonly<{
    id: Id;
    approval: { result: 'required' };
    inputSchema: (typeof DiagnosticsActionInputSchemas)[Id];
    outputSchema: (typeof DiagnosticsActionOutputSchemas)[Id];
  }>;
}[keyof typeof DiagnosticsActionInputSchemas];
export const DIAGNOSTICS_ACTION_SPECS: readonly DiagnosticsActionSpec[] = lazyActionSpecArray(() => [
  { ...diagnosticRead, id: 'diagnostics.diagnosis.run', approval: {result: 'required'}, title: 'Run diagnosis',
    description: 'Run the mounted Diagnosis page checks on its current Home and Account, including its pasted doctor document. Return sanitized findings without native logs.',
    inputSchema: DiagnosticsActionInputSchemas['diagnostics.diagnosis.run'], outputSchema: DiagnosticsActionOutputSchemas['diagnostics.diagnosis.run'],
    cli: { acceptsServerId: true, commands: [{ path: ['diagnostics', 'diagnosis', 'run'], visibility: 'canonical' }] } },
  { ...diagnosticRead, id: 'diagnostics.daemons.check', approval: {result: 'required'}, title: 'Check daemons',
    description: 'Refresh the mounted System status page daemon attribution through its existing doctor snapshot owner. Return each checked Machine status.',
    inputSchema: DiagnosticsActionInputSchemas['diagnostics.daemons.check'], outputSchema: DiagnosticsActionOutputSchemas['diagnostics.daemons.check'],
    cli: { acceptsServerId: true, commands: [{ path: ['diagnostics', 'daemons', 'check'], visibility: 'canonical' }] } },
  { ...diagnosticRead, id: 'diagnostics.status.get', approval: {result: 'required'}, title: 'Read System status export',
    description: 'Read the sanitized JSON produced by Copy JSON on the mounted System status page, without writing the device clipboard.',
    inputSchema: DiagnosticsActionInputSchemas['diagnostics.status.get'], outputSchema: DiagnosticsActionOutputSchemas['diagnostics.status.get'],
    projectObservationOutput: (value: unknown) => {
      const parsed = DiagnosticsActionOutputSchemas['diagnostics.status.get'].safeParse(value);
      return parsed.success ? { status: parsed.data.status } : null;
    },
    cli: { acceptsServerId: true, commands: [{ path: ['diagnostics', 'status', 'get'], visibility: 'canonical' }] } },
] as const satisfies readonly PreNormalizedActionSpec[]);
