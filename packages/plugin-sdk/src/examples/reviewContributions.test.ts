import { expect, it } from 'vitest';
import { createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { normalizePluginDeclarativeDocumentV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDocument';
import * as author from '../../examples/public-authoring/reviewContributions.js';

it('activates an independent public author and reads its namespaced finding evidence through the registered Resource', async () => {
    const host = await createPluginTestkit({ manifest: author.manifest, module: author });
    try {
        const resource = host.registration('resources', 'evidence');
        if (!resource) throw new Error('Missing admitted evidence Resource');
        for (const namespace of ['example.review-evidence', 'another.reviewer']) {
            const bytes = await resource.read(createTestResourceInvocationContext({ context: {
                kind: 'surface', mountInstanceKey: 'opened-finding', launchInput: null,
                review: { kind: 'finding', reviewId: 'review-1', commentId: 'comment-1', namespace,
                    extension: { reproduction: 'Remove the retry owner; the reconnect fails.' } },
            } }));
            const document = normalizePluginDeclarativeDocumentV1({
                pluginId: author.manifest.id, occurrenceId: 'independent-review-author',
                document: JSON.parse(String(bytes)), actions: [],
            });
            expect(document).toMatchObject({ root: { kind: 'group', children: [{ kind: 'text',
                text: namespace === author.manifest.id ? 'Remove the retry owner; the reconnect fails.'
                    : 'Open a finding to read its reproduction.',
            }] } });
        }
    } finally { await host.dispose(); }
});
