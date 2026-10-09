import * as React from 'react';

import type { ProjectSourcesController } from '@/components/projects/sources/projectSourcesController';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import { ShareSheet } from '../ShareSheet';
import { createProjectSourceShareAdapter } from './projectSourceShareAdapter';
import { useProjectSourceShareController } from './useProjectSourceShareController';

type ProjectSourceShareModalProps = CustomModalInjectedProps & Readonly<{ controller: ProjectSourcesController }>;

function ProjectSourceShareModal(props: ProjectSourceShareModalProps): React.ReactElement {
    const share = useProjectSourceShareController({ controller: props.controller, enabled: true });
    const [adapter] = React.useState(createProjectSourceShareAdapter);
    return <ShareSheet model={share.model} actions={share.actions} adapter={adapter}
        presentation="full" onRequestClose={props.onClose} testID="project-source-share" />;
}

/**
 * The one share sheet for a Source (Account, Team or group; view grants only), over the page's own
 * Sources controller so every grant goes through the selected Source's acknowledged revision.
 */
export function showProjectSourceShareSheet(params: Readonly<{ controller: ProjectSourcesController; name: string }>): void {
    Modal.show({
        component: ProjectSourceShareModal,
        props: { controller: params.controller },
        chrome: {
            kind: 'card',
            phonePresentation: 'sheet',
            testID: 'project-source-share-modal',
            title: t('shareSheet.documents.shareTitle', { name: params.name }),
            scrollHost: 'overlay',
            bodyScroll: 'none',
            dimensions: { width: 560, maxHeightRatio: 0.92, size: 'md' },
        },
        closeOnBackdrop: true,
    });
}
