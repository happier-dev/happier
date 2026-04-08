import { describe, expect, it } from 'vitest';

import { collectSupportBugReportArtifacts } from './collectSupportBugReportArtifacts';
import type { SupportReport } from '../types';

const report: SupportReport = {
  capturedAt: '2026-04-07T10:11:12.000Z',
  inventory: {
    invokedBinaryPath: '/opt/happier/bin/happier',
    invokedVersion: '1.2.3',
    nodeVersion: 'v22.0.0',
    platform: 'linux',
    installations: [
      { id: 'cli', kind: 'installation', label: 'Happier CLI', version: '1.2.3' },
    ],
    services: [
      { id: 'daemon', kind: 'daemon', label: 'Daemon', status: 'running', ring: 'stable' },
      { id: 'stack', kind: 'stack-service', label: 'Stack service', status: 'running', ring: null },
    ],
    runtimeTargets: [],
    warnings: [
      { code: 'DUPLICATE_SERVICE', title: 'Duplicate daemon services detected', severity: 'error' },
    ],
    note: 'operator note: api_key=secret-value',
  },
};

describe('collectSupportBugReportArtifacts', () => {
  it('maps support inventories to the accepted bug-report artifact kinds', () => {
    const artifacts = collectSupportBugReportArtifacts(report, {
      acceptedKinds: ['cli', 'daemon', 'stack-service', 'user-note'],
      maxArtifactBytes: 4096,
    });

    expect(artifacts.map((artifact) => artifact.sourceKind)).toEqual(['cli', 'daemon', 'stack-service', 'user-note']);
    expect(artifacts[0]?.content).toContain('Happier CLI');
    expect(artifacts[1]?.content).toContain('Daemon');
    expect(artifacts[1]?.content).not.toContain('Stack service');
    expect(artifacts[2]?.content).toContain('Stack service');
    expect(artifacts[3]?.content).not.toContain('secret-value');
    expect(artifacts[0]?.content).not.toContain('/opt/happier/bin/happier');
  });
});
