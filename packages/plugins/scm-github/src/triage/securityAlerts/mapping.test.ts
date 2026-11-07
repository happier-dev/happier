import { describe, expect, it } from 'vitest';
import { decodeGithubSecurityAlert } from './contracts.js';
import { projectGithubSecurityAlert } from './mapping.js';
import { toTriageScanObservation } from '../mapping/protocol.js';
import { TriageSourceScanObservationV1Schema } from '@happier-dev/triage-protocol/v1';

const alertKinds = ['dependabot-alert', 'code-scanning-alert'] as const;
const nativeAlert = { number: 1, state: 'open', created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z', security_advisory: { summary: 'Vulnerability', severity: 'high' },
  rule: { id: 'rule', description: 'Rule finding', severity: 'error', security_severity_level: 'high' } };

describe('native security finding projection', () => {
  it('fits native package and location summaries inside the existing four-fact geometry', () => {
    const alert = decodeGithubSecurityAlert('dependabot-alert', { number: 1, state: 'open',
      created_at: '2026-10-01T00:00:00Z', security_advisory: { summary: 'Finding', severity: 'medium' },
      dependency: { package: { name: 'library', ecosystem: 'npm' }, manifest_path: 'package.json' },
      security_vulnerability: { vulnerable_version_range: '< 2.0', first_patched_version: { identifier: '2.0' } } });
    if (alert === null) throw new Error('native alert');
    const projected = projectGithubSecurityAlert({ alert, repositoryId: '100', repositoryKey: 'org/app' });
    if (projected === null) throw new Error('native repository');
    expect(projected.snapshot.rowFacts).toHaveLength(4);
    expect(projected.snapshot.rowFacts).toMatchObject([
      { value: { value: 'Medium' } }, { value: { value: 'npm: library' } },
      { value: { value: 'package.json' } }, { value: { value: 'Affected < 2.0; patched 2.0' } },
    ]);
    expect(TriageSourceScanObservationV1Schema.safeParse(toTriageScanObservation(projected)).success).toBe(true);
    const changed = decodeGithubSecurityAlert('dependabot-alert', { ...alert.native,
      dependency: { package: { name: 'other-library', ecosystem: 'npm' }, manifest_path: 'package.json' } });
    if (changed === null) throw new Error('changed native package');
    const next = projectGithubSecurityAlert({ alert: changed, repositoryId: '100', repositoryKey: 'org/app', previous: projected });
    expect(next?.snapshot.rowFacts[0]).toBe(projected.snapshot.rowFacts[0]);
    expect(next?.snapshot.rowFacts[1]).not.toBe(projected.snapshot.rowFacts[1]);
    expect(next?.snapshot.rowFacts[2]).toBe(projected.snapshot.rowFacts[2]);
    expect(next?.snapshot.rowFacts[3]).toBe(projected.snapshot.rowFacts[3]);
  });
  it('keeps kind-qualified identity and equal baseline identities', () => {
    for (const kindId of alertKinds) {
      const alert = decodeGithubSecurityAlert(kindId, nativeAlert);
      if (alert === null) throw new Error('valid native finding');
      const projected = projectGithubSecurityAlert({ alert, repositoryId: '100', repositoryKey: 'org/app' });
      if (projected === null) throw new Error('valid repository identity');
      expect(projected.localRef).toEqual({ kindId, collisionScope: 'github:100', entryId: '1' });
      expect(TriageSourceScanObservationV1Schema.safeParse(toTriageScanObservation(projected)).success).toBe(true);
      expect(projectGithubSecurityAlert({ alert: { ...alert, native: { ...nativeAlert } }, repositoryId: '100',
        repositoryKey: 'org/app', previous: projected })).toBe(projected);
    }
  });
  it('normalizes native historical states without inventing scanning auto-dismissal', () => {
    for (const kindId of alertKinds) {
      for (const state of ['fixed', 'dismissed', 'auto_dismissed', 'future_state']) {
        const changed = decodeGithubSecurityAlert(kindId, { ...nativeAlert, state });
        if (changed === null) throw new Error('native state stays explicit');
        const next = projectGithubSecurityAlert({ alert: changed, repositoryId: '100', repositoryKey: 'org/app' });
        expect(next?.snapshot.state.presentation).toBe(state === 'fixed' ? 'resolved'
          : state === 'dismissed' || state === 'auto_dismissed' && kindId === 'dependabot-alert' ? 'suppressed' : 'unknown');
        expect(next?.viewer.sourceAttention?.level).toBe('none');
        expect(next?.snapshot.state.nativeLabel).toBe(state);
      }
    }
  });
  it('requires attention only for open high security severity and keeps rule error separate', () => {
    for (const kindId of alertKinds) {
      for (const severity of ['critical', 'high', 'medium', 'low', null]) {
        const alert = decodeGithubSecurityAlert(kindId, { ...nativeAlert,
          security_advisory: { summary: 'Finding', severity },
          rule: { id: 'rule', severity: 'error', security_severity_level: severity } });
        if (alert === null) throw new Error('native severity');
        const projected = projectGithubSecurityAlert({ alert, repositoryId: '100', repositoryKey: 'org/app' });
        expect(projected?.viewer.sourceAttention?.level).toBe(severity === 'critical' || severity === 'high' ? 'required' : 'none');
        if (severity === null) expect(projected?.snapshot.rowFacts[0]?.value).toMatchObject({ kind: 'status', value: 'Unknown severity' });
      }
    }
  });
});
