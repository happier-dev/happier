import * as React from 'react';
import { defineUiSurface, MarkdownEditor, Tabs } from '@happier-dev/plugin-ui';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageEvidenceDisclosureProvider } from '@happier-dev/triage-sources/ui';

import { renderScreen } from '@/dev/testkit';
import { PullRequestReviewPublicationWrite } from '../../../../../../packages/plugins/scm-github/src/ui/detail/reviewPublicationControls';
import { createTriageMountedUiActionHandler } from '../../../../../../packages/plugins/triage/src/actions/mountedUi';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { bindTriageMountedUiActions } from '../../../../../../packages/plugins/triage/src/ui/mountedActions';
import { useTriageSourcePanelActionsV1 } from '../../../../../../packages/plugins/triage/src/ui/useSourcePanelActions';

export const handleMountedReviewAction = createTriageMountedUiActionHandler();

export async function mountGithubReviewPublication({ mountId, scope }: Readonly<{
    mountId: string;
    scope: PluginEphemeralSharedScope;
}>) {
    const base = createTriageSourceV1Fixture().detailInput;
    const input = { ...base, panel: 'reviews' as const };
    const proposals = { status: 'ready', proposals: [] } satisfies React.ComponentProps<typeof PullRequestReviewPublicationWrite>['publicationProposals'];
    const Publication = defineUiSurface(function Publication({ hostApi }) {
        const { actions } = useTriageSourcePanelActionsV1(scope, mountId, input.observation.entryRef.entryId, true, hostApi);
        // Open the same mounted registry entry as the parent detail. Its other
        // operations have no handler in this publication-only surface.
        React.useLayoutEffect(() => bindTriageMountedUiActions(scope, mountId, async () => ({ status: 'unavailable' })), []);
        return (
            <TriageEvidenceDisclosureProvider disclosure={{
                available: false, disclose: async () => ({ kind: 'inert' }), panelActions: actions,
            }}>
                <Tabs value="reviews" onValueChange={() => {}} ariaLabel="Pull request">
                    <Tabs.Item value="reviews" title="Reviews">
                        <PullRequestReviewPublicationWrite input={input} open onOpenChange={() => {}}
                            publicationProposals={proposals}
                            WriteControl={() => null} onObserved={() => {}} capabilities={{ kind: 'loading' }} />
                    </Tabs.Item>
                </Tabs>
            </TriageEvidenceDisclosureProvider>
        );
    });
    return await createPluginUiTestkit({
        identity: { instanceId: mountId, mountNonce: 'review-renderer' },
        authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
        surfaceContext: createSurfaceContextFixture(),
        surface: Publication,
        adapter: {
            async mount({ surface, context }) {
                const screen = await renderScreen(surface(context));
                return {
                    async snapshot() {
                        const editor = screen.findByType(MarkdownEditor);
                        return { revision: 0, nodes: [{
                            handle: 'summary', role: 'textbox', name: editor.props.accessibilityLabel, value: editor.props.value,
                        }] };
                    },
                    async update(nextContext) { await screen.update(surface(nextContext)); },
                    async invoke() { throw new Error('The summary is edited through the mounted Action'); },
                    dispose: screen.unmount,
                };
            },
        },
    });
}
