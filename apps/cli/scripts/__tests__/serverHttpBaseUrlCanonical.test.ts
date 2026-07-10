import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  normalizeServerHttpBaseUrl as normalizeApiServerHttpBaseUrl,
  resolveServerHttpBaseUrl as resolveApiServerHttpBaseUrl,
} from '@/api/client/serverHttpBaseUrl';
import {
  normalizeServerHttpBaseUrl as normalizeTransportServerHttpBaseUrl,
  resolveServerHttpBaseUrl as resolveTransportServerHttpBaseUrl,
} from '@/session/transport/http/serverHttpBaseUrl';

function readCliSource(relativePath: string): string {
  return readFileSync(new URL(`../../src/${relativePath}`, import.meta.url), 'utf8');
}

describe('CLI server HTTP base URL canonical helper', () => {
  it('keeps session transport as a re-export of the API client helper', () => {
    expect(resolveTransportServerHttpBaseUrl).toBe(resolveApiServerHttpBaseUrl);
    expect(normalizeTransportServerHttpBaseUrl).toBe(normalizeApiServerHttpBaseUrl);
  });

  it('does not keep local artifact helper implementations competing with the API client helper', () => {
    const approvalArtifactStore = readCliSource('session/actions/approvals/artifactStore.ts');
    const promptArtifactStore = readCliSource('agent/prompts/library/resolveCliPromptStackSystemAppendBlocks.ts');

    for (const source of [approvalArtifactStore, promptArtifactStore]) {
      expect(source).toContain("import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';");
      expect(source).not.toMatch(/function\s+resolveServerHttpBaseUrl\s*\(/);
      expect(source).not.toContain('resolveLoopbackHttpUrl(configuration.apiServerUrl)');
    }
  });
});
