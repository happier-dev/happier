import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { Button, ErrorState, defineUiSurface, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { isReviewTriageEntryRefV1, TriageDetailSurfaceInputV1Schema, type TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';

export function readReviewDetailInput(value: unknown): TriageDetailSurfaceInputV1 | null {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const ref = parsed.data.observation.entryRef;
    return isReviewTriageEntryRefV1(ref) ? parsed.data : null;
}

/** Triage owns the entry heading; the Artifact viewer owns Review content and decisions. */
export function ReviewDetail({ context, input }: Readonly<{ context: RenderContext; input: TriageDetailSurfaceInputV1 | null }>): React.ReactElement {
    const host = usePluginHostApi();
    const text = usePluginTranslation();
    if (input === null) return <ErrorState title={text('plugins.triage.reviews.unavailable', 'This Review could not be opened')} />;
    return <Button title={text('plugins.triage.reviews.open', 'Open Review')}
        onPress={() => host.openResource({ kind: 'artifact', artifactId: input.observation.entryRef.entryId }, { signal: context.signal })} />;
}

export const renderSurface: RenderSurface = defineUiSurface(context => <ReviewDetail context={context} input={readReviewDetailInput(context.launchInput)} />);
