import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { runPackedPluginTest } from './packedTest';

/**
 * `--with-plugin` is repeatable, so a packed run can pack several companion
 * projects before the target. Without the subject on the diagnostic, every one
 * of those failures reads identically and the author has to bisect their own
 * command line to find out which input was rejected.
 */
it('attributes a companion pack failure to its exact --with-plugin role, index and locator', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'happier-packed-attribution-target-'));
  const brokenCompanionRoot = await mkdtemp(join(tmpdir(), 'happier-packed-attribution-companion-'));

  try {
    const result = await runPackedPluginTest({
      projectRoot,
      prerequisiteLocators: [
        // An archive locator is resolved without packing, so the failing
        // project below really is the second requested companion.
        join(tmpdir(), 'happier-packed-attribution-first.tgz'),
        brokenCompanionRoot,
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.subject).toEqual({
        role: 'prerequisite',
        index: 1,
        locator: brokenCompanionRoot,
      });
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(brokenCompanionRoot, { recursive: true, force: true });
  }
}, 120_000);

it('attributes a target pack failure to the target rather than a companion', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'happier-packed-attribution-only-target-'));

  try {
    const result = await runPackedPluginTest({ projectRoot });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.subject).toEqual({ role: 'target', locator: result.projectRoot });
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}, 120_000);
