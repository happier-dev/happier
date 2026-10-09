import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import type { ArtifactBrowserKind } from './artifactBrowserModel';

/** Each kind's mark: the same glyph its own destination uses (Boards, Workflows, Prompts, Roles, Launch profiles). */
export const ARTIFACT_KIND_ICONS: Readonly<Record<ArtifactBrowserKind, IconName>> = {
    document: 'file-text',
    prompt: 'books',
    memory: 'bookmark',
    board: 'squares-four',
    workflow: 'tree-structure',
    role: 'users',
    launchProfile: 'person',
};

/** A kind's name for one artifact ("Board"). */
export function artifactKindLabel(kind: ArtifactBrowserKind): string {
    switch (kind) {
        case 'document': return t('artifacts.browser.kindOne.document');
        case 'prompt': return t('artifacts.browser.kindOne.prompt');
        case 'memory': return t('artifacts.browser.kindOne.memory');
        case 'board': return t('artifacts.browser.kindOne.board');
        case 'workflow': return t('artifacts.browser.kindOne.workflow');
        case 'role': return t('artifacts.browser.kindOne.role');
        case 'launchProfile': return t('artifacts.browser.kindOne.launchProfile');
    }
}

/** A kind's filter name ("Boards"). */
export function artifactKindFilterLabel(kind: ArtifactBrowserKind | 'all'): string {
    switch (kind) {
        case 'all': return t('artifacts.browser.kinds.all');
        case 'document': return t('artifacts.browser.kinds.document');
        case 'prompt': return t('artifacts.browser.kinds.prompt');
        case 'memory': return t('artifacts.browser.kinds.memory');
        case 'board': return t('artifacts.browser.kinds.board');
        case 'workflow': return t('artifacts.browser.kinds.workflow');
        case 'role': return t('artifacts.browser.kinds.role');
        case 'launchProfile': return t('artifacts.browser.kinds.launchProfile');
    }
}

/** The open action a recipient sees for a kind that lives in its own destination. */
export function artifactKindOpenLabel(kind: ArtifactBrowserKind): string {
    switch (kind) {
        case 'document': return t('artifacts.browser.open.document');
        case 'prompt': return t('artifacts.browser.open.prompt');
        case 'memory': return t('artifacts.browser.open.memory');
        case 'board': return t('artifacts.browser.open.board');
        case 'workflow': return t('artifacts.browser.open.workflow');
        case 'role': return t('artifacts.browser.open.role');
        case 'launchProfile': return t('artifacts.browser.open.launchProfile');
    }
}
