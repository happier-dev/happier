import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sharedFlowUrls = [
  new URL('../../../suites/mobile-e2e/flows/_shared/connectDevClientIfNeeded.yaml', import.meta.url),
  new URL('../../../suites/mobile-e2e/flows/_shared/connectUsingLaunchUrl.yaml', import.meta.url),
];

const manualEntryFlowUrl = new URL(
  '../../../suites/mobile-e2e/flows/_shared/connectUsingManualEntry.yaml',
  import.meta.url,
);
const expoDevMenuOverlayFlowUrl = new URL(
  '../../../suites/mobile-e2e/flows/_shared/dismissExpoDevMenuOverlayMaybe.yaml',
  import.meta.url,
);
const mobileFlowsRootUrl = new URL('../../../suites/mobile-e2e/flows', import.meta.url);
const populatedRelayPerformanceSmokeUrl = new URL(
  '../../../suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
  import.meta.url,
);

function listYamlFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return listYamlFiles(path);
      }
      return entry.endsWith('.yaml') ? [path] : [];
    });
}

describe('mobile Dev Client flow contracts', () => {
  it('recognizes native Expo DevLauncher error screens as bootstrap states', () => {
    for (const flowUrl of sharedFlowUrls) {
      const flow = readFileSync(flowUrl, 'utf8');
      expect(flow).toContain('There was a problem loading the project');
      expect(flow).toContain('Go To Home');
    }
  });

  it('recognizes Expo developer-menu onboarding as a bootstrap state', () => {
    for (const flowUrl of sharedFlowUrls) {
      const flow = readFileSync(flowUrl, 'utf8');
      expect(flow).toContain('This is the developer menu');
      expect(flow).toContain('Continue');
    }
  });

  it('fails the bootstrap flow before app-specific waits when native DevLauncher load fails', () => {
    const flow = readFileSync(sharedFlowUrls[0], 'utf8');
    expect(flow).toContain('assertNotVisible: "There was a problem loading the project"');
    expect(flow).toContain('assertNotVisible: "Go To Home"');
  });

  it('retries native DevLauncher timeout screens with the Reload affordance before failing fast', () => {
    const flow = readFileSync(sharedFlowUrls[0], 'utf8');

    expect(flow).toContain('visible: "Reload"');
    expect(flow).toContain('tapOn: "Reload"');
  });

  it('opens the current Expo Dev Client manual-entry affordance before connecting', () => {
    const flow = readFileSync(manualEntryFlowUrl, 'utf8');

    expect(flow).toContain('visible: "Enter URL manually"');
    expect(flow).toContain('tapOn: "Enter URL manually"');

    for (const sharedFlowUrl of sharedFlowUrls) {
      expect(readFileSync(sharedFlowUrl, 'utf8')).toContain('Enter URL manually');
    }
  });

  it('does not fail overlay dismissal when the Expo close affordance is absent', () => {
    const flow = readFileSync(expoDevMenuOverlayFlowUrl, 'utf8');

    expect(flow).toContain('visible: "Close"');
    expect(flow).toContain('tapOn: "Close"');
  });

  it('keeps runFlow file references resolvable relative to their owner flow', () => {
    const missingReferences: string[] = [];
    for (const flowPath of listYamlFiles(mobileFlowsRootUrl.pathname)) {
      const flow = readFileSync(flowPath, 'utf8');
      for (const match of flow.matchAll(/^\s*file:\s*([^#\n]+?)\s*$/gm)) {
        const referencedFile = match[1]?.trim();
        if (!referencedFile || referencedFile.includes('${')) continue;
        const target = join(dirname(flowPath), referencedFile);
        if (!existsSync(target)) {
          missingReferences.push(`${flowPath} -> ${referencedFile}`);
        }
      }
    }

    expect(missingReferences).toEqual([]);
  });

  it('waits for a stable transcript or empty-session surface after populated relay session open', () => {
    const flow = readFileSync(populatedRelayPerformanceSmokeUrl, 'utf8');

    expect(flow).toContain('id: "(transcript-chat-list|session-empty-messages)"');
  });

  it('returns to the session list before populated relay row selection', () => {
    const flow = readFileSync(populatedRelayPerformanceSmokeUrl, 'utf8');

    expect(flow).toContain('id: session-header-back');
    expect(flow.indexOf('id: session-header-back')).toBeLessThan(flow.indexOf('id: "session-list-item-.*"'));
  });

  it('force-loads the current Metro bundle before populated relay telemetry waits', () => {
    const flow = readFileSync(populatedRelayPerformanceSmokeUrl, 'utf8');

    expect(flow).toContain('file: _shared/connectUsingLaunchUrl.yaml');
    expect(flow.indexOf('file: _shared/connectUsingLaunchUrl.yaml')).toBeLessThan(
      flow.indexOf('file: _shared/connectDevClientIfNeeded.yaml'),
    );
  });
});
