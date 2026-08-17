import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const sourceFile = (relativePath: string) => new URL(relativePath, import.meta.url);

async function source(relativePath: string): Promise<string> {
  return await readFile(sourceFile(relativePath), 'utf8');
}

describe('OpenCode catalog-control predecessor contraction', () => {
  it('removes the zero-consumer adapter while preserving active skills and contextual endpoint reads', async () => {
    await expect(access(sourceFile('./catalog/control.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(sourceFile('./catalog/control.test.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const [
      packageIndex,
      sessionRuntime,
      endpoint,
      externalClient,
      externalContribution,
      externalObservation,
    ] = await Promise.all([
      source('../../../index.ts'),
      source('./sessionRuntime.ts'),
      source('./endpoint.ts'),
      source('../../surfaces/sessions/external/client.ts'),
      source('../../surfaces/sessions/external/contribution.ts'),
      source('../../surfaces/sessions/external/observation.ts'),
    ]);

    expect(packageIndex).not.toContain('catalog/control');
    expect(sessionRuntime).toContain("from './skills.js'");
    expect(sessionRuntime).toContain('normalizeOpenCodeSkills');
    expect(endpoint).not.toContain('resolveOpenCodeManagedServerTransport');
    expect(endpoint).not.toContain('resolveOpenCodeManagedServerEndpointRegistration');

    for (const activeEndpointConsumer of [
      externalClient,
      externalContribution,
      externalObservation,
    ]) {
      expect(activeEndpointConsumer).toContain(
        'managedEndpointRead',
      );
    }
  });
});
