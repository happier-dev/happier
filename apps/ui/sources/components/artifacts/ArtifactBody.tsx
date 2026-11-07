import * as React from 'react';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { WIDGET_DEFINITION_ARTIFACT_KIND_V1, WIDGET_SURFACE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/widgets';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ArtifactViewRead } from '@/sync/engine/artifacts/syncArtifacts';
import { sync } from '@/sync/sync';
import { t } from '@/text';

import { isArtifactTextDocument, readArtifactCodeLanguage } from './artifactBrowserModel';
import { ArtifactDashboardBody } from './ArtifactDashboardBody';
import { ArtifactBinaryBody } from './ArtifactBinaryBody';
import { ArtifactHtmlBody } from './ArtifactHtmlBody';
import { ArtifactWidgetBody } from './ArtifactWidgetBody';
import { ArtifactPassageSelection, type ArtifactPassageMargin } from './ArtifactPassageSelection';
import { showArtifactPassageRefineSheet } from './ArtifactPassageRefineSheet';
import { ArtifactProseBody } from './ArtifactProseBody';

/** Dispatch the opened body through its one kind-specific renderer. */
export function ArtifactBody(props: Readonly<{
    artifact: DecryptedArtifact;
    prepared: ArtifactViewRead | null;
    onRetry: () => void;
    margin?: ArtifactPassageMargin;
}>) {
    const artifact = props.artifact;
    if (isArtifactHtmlHeaderV1(artifact.rawHeader ?? artifact.header)) return <ArtifactHtmlBody
        artifactId={artifact.id} headerVersion={artifact.headerVersion} bodyVersion={artifact.bodyVersion}
        body={artifact.body} name={artifact.title || t('artifacts.untitled')} readPreview={sync.fetchArtifactHtmlPreview}
        preview={props.prepared?.htmlPreview} onRetry={props.onRetry} />;
    if ((artifact.rawHeader ?? artifact.header)?.kind === WIDGET_DEFINITION_ARTIFACT_KIND_V1) return <ArtifactWidgetBody
        artifactId={artifact.id} bodyVersion={artifact.bodyVersion} />;
    if ((artifact.rawHeader ?? artifact.header)?.kind === WIDGET_SURFACE_ARTIFACT_KIND_V1) return <ArtifactDashboardBody
        artifact={artifact} onRetry={props.onRetry} />;
    if (artifact.body !== null && typeof artifact.body === 'object') return <ArtifactBinaryBody
        artifactId={artifact.id} reference={artifact.body} name={artifact.title || t('artifacts.untitled')} readBytes={sync.fetchArtifactBinary}
        initialBytes={props.prepared?.binaryBytes} onRetry={props.onRetry} />;
    const body = typeof artifact.body === 'string' ? artifact.body : '';
    const language = readArtifactCodeLanguage(artifact);
    // A code document's fence is presentation, never a selectable Doc passage; nor is a structured kind's body.
    if (language || artifact.bodyVersion === undefined || typeof artifact.body !== 'string' || !isArtifactTextDocument(artifact)) {
        const markdown = language && body.length > 0 ? `\`\`\`${language.toLowerCase()}\n${body}\n\`\`\`` : body;
        return <ArtifactProseBody testID="artifact:body" markdown={markdown} />;
    }
    return <ArtifactPassageSelection artifactId={artifact.id} markdown={body}
        revision={{ headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion }}
        margin={props.margin} onRequestNativeSelection={showArtifactPassageRefineSheet} />;
}
