import type { DeploymentSourceIntentV1 } from '@happier-dev/deployments/contracts/v1';
import { afterEach, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const { DeploymentVersionComparison } = await import('./DeploymentVersionComparison');
const { CodeBlockView } = await import('@/components/ui/code/blocks/CodeBlockView');

afterEach(() => standardCleanup());

const source = { kind: 'stored', contentRevision: 2, composeDigest: `sha256:${'a'.repeat(64)}`,
  document: 'services:\n  web:\n    image: nginx:alpine\n', publicFiles: [], profiles: [], services: [] } as never;

// PAGE-ACCEPT-176 R12-D10: the Overview summarizes what is deployed; its Compose YAML waits one press away, while the
// Receipt (the deploy's own page) keeps the document open.
it('keeps the deployed Compose file one press away on the Overview, and open on the Receipt', async () => {
  const props = { source, current: null, serverId: 'home', accountId: 'account', demand: { mounted: true, visible: true, focused: true } };
  const summary = await renderScreen(<DeploymentVersionComparison {...props} presentation="summary" />);
  expect(summary.findAllByType(CodeBlockView)).toHaveLength(0);
  await summary.pressByTestIdAsync('project-deployments.receipt.definition.documentToggle');
  expect(summary.findAllByType(CodeBlockView).map(block => block.props.code)).toEqual(['services:\n  web:\n    image: nginx:alpine\n']);
  await summary.unmount();
  const detail = await renderScreen(<DeploymentVersionComparison {...props} />);
  expect(detail.findAllByType(CodeBlockView)).toHaveLength(1);
});

it.each(['summary', 'detail'] as const)('shows the captured folder version in %s without offering repository comparison', async presentation => {
  const folder: DeploymentSourceIntentV1 = {
    kind: 'folder', workspaceId: 'workspace', manifestFingerprint: `sha256:${'b'.repeat(64)}`,
    fileCount: 5, totalBytes: 240, excludedPaths: [],
  };
  const screen = await renderScreen(<DeploymentVersionComparison source={folder} current={null} presentation={presentation}
    serverId="home" accountId="account" demand={{ mounted: true, visible: true, focused: true }} />);
  expect(screen.getTextContent()).toContain('bbbbbbb');
  expect(screen.findAllByTestId('project-deployments.comparison')).toHaveLength(0);
});
