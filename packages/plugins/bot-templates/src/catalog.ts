import { readBotTemplateReleaseV1, type BotTemplateReleaseSourceV1, type ResolvedBotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import releaseCaptain from '../resources/bots/release-captain.json' with { type: 'json' };
import prReviewer from '../resources/bots/pr-reviewer.json' with { type: 'json' };
import ciFixer from '../resources/bots/ci-fixer.json' with { type: 'json' };
import dependencyGardener from '../resources/bots/dependency-gardener.json' with { type: 'json' };
import issueSorter from '../resources/bots/issue-sorter.json' with { type: 'json' };
import docsKeeper from '../resources/bots/docs-keeper.json' with { type: 'json' };
import specDrafter from '../resources/bots/spec-drafter.json' with { type: 'json' };
import supportDesk from '../resources/bots/support-desk.json' with { type: 'json' };
import standupWriter from '../resources/bots/standup-writer.json' with { type: 'json' };
import machineCaretaker from '../resources/bots/machine-caretaker.json' with { type: 'json' };

export const BOT_TEMPLATES_BUNDLE_ID = 'happier.bot.templates';
const sourceId = `${BOT_TEMPLATES_BUNDLE_ID}/bundled`;
type PluginTemplateSource = Extract<BotTemplateReleaseSourceV1, { kind: 'plugin' }>;
const releases = {
    'release-captain': releaseCaptain, 'pr-reviewer': prReviewer, 'ci-fixer': ciFixer,
    'dependency-gardener': dependencyGardener, 'issue-sorter': issueSorter, 'docs-keeper': docsKeeper,
    'spec-drafter': specDrafter, 'support-desk': supportDesk, 'standup-writer': standupWriter,
    'machine-caretaker': machineCaretaker,
};

export const bundledBotTemplateContributions = Object.fromEntries(
    Object.keys(releases).map(id => [id, { path: `resources/bots/${id}.json` }]),
);

export function listBundledBotTemplates() {
    return Object.entries(releases).map(([contributionId, release]) => ({
        source: {
            kind: 'plugin', contributionId,
            registryItem: { sourceId, itemId: BOT_TEMPLATES_BUNDLE_ID, version: release.version },
        } satisfies PluginTemplateSource,
        identity: readBotTemplateReleaseV1(release).content.identity,
    }));
}

export function isBundledBotTemplateSource(source: BotTemplateReleaseSourceV1): boolean {
    return source.kind === 'plugin' && source.registryItem.sourceId === sourceId;
}

/** Shipped assets supply their own provenance. The ordinary Store registry may never back this source. */
export function readBundledBotTemplate(source: PluginTemplateSource, purpose?: 'update'): ResolvedBotTemplateReleaseV1 | null {
    if (!isBundledBotTemplateSource(source) || source.registryItem.itemId !== BOT_TEMPLATES_BUNDLE_ID
        || !Object.hasOwn(releases, source.contributionId)) return null;
    const release = releases[source.contributionId as keyof typeof releases];
    if (purpose !== 'update' && release.version !== source.registryItem.version) return null;
    return readBotTemplateReleaseV1(release, { ...source, registryItem: { ...source.registryItem, version: release.version } });
}
