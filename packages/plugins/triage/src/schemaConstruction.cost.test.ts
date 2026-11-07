import { Session } from 'node:inspector/promises';
import { PluginJsonSchemaV2Schema } from '@happier-dev/protocol';
import { expect, it, vi } from 'vitest';

it('imports the Triage entry without re-admitting constructor-owned schema documents', async () => {
  // Observe the real import and validator. No parser or module is replaced.
  const admit = PluginJsonSchemaV2Schema.safeParse.bind(PluginJsonSchemaV2Schema);
  let constructorImportAdmissions = 0;
  const admissions = vi.spyOn(PluginJsonSchemaV2Schema, 'safeParse').mockImplementation((...args) => {
    // Distinguish repeated constructor admission from genuine custom-document
    // ingress in the same entry graph. Keep the actual validator running.
    if (new Error().stack?.includes('createProtocolComposableSchemaForPurpose')) constructorImportAdmissions += 1;
    return admit(...args);
  });
  const session = new Session();
  session.connect();
  const modules = new Set<string>();
  session.on('Debugger.scriptParsed', ({ params }) => {
    if (/packages\/(?:plugins\/triage|triage-protocol)\//u.test(params.url)) modules.add(params.url);
  });
  try {
    await session.post('Debugger.enable');
    await session.post('HeapProfiler.startSampling', { samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    await import('./index.js');
    const { TriageListEntriesInputV1Schema } = await import('./actions/listEntriesProtocol.js');
    const { profile } = await session.post('HeapProfiler.stopSampling');
    const sumBytes = (node: typeof profile.head): number => node.selfSize
      + node.children.reduce((sum, child) => sum + sumBytes(child), 0);
    const importAdmissions = admissions.mock.calls.length;
    admissions.mockClear();
    const input = { v: 1, sources: { kind: 'allConfigured' }, limit: 1, order: 'newest' };
    expect(TriageListEntriesInputV1Schema.parse(input)).toEqual(input);
    expect(TriageListEntriesInputV1Schema.safeParse({ ...input, extra: true }).success).toBe(false);
    expect(admissions.mock.calls.length).toBe(0);
    console.info('triage-schema-import', { modulesEvaluated: modules.size, importAdmissions,
      constructorImportAdmissions, importAllocationSampleBytes: sumBytes(profile.head),
      firstInputSchemaAdmissions: admissions.mock.calls.length });
    expect(constructorImportAdmissions).toBe(0);
  } finally {
    admissions.mockRestore();
    session.disconnect();
  }
});
