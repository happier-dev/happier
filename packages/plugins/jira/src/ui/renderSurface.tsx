import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { Button, ErrorState, LoadingState, Metadata, Text, defineUiSurface, useExecutePluginAction, usePluginTranslation, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { TriageDetailInstance, TriageDetailPanel, TriageDetailStory, TriageSourceCommentComposer, useTriageDetailRequest } from '@happier-dev/triage-sources/ui';
import { TriageDetailSurfaceInputV1Schema, TriageSourceConnectedAccountInputsV1, describeTriageSourceFailureV1, type TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { JIRA_ACTIONS, JIRA_PLUGIN_ID } from '../contracts.js';
import { JiraDetailResultSchema, type JiraDetailResult } from '../source/detailContract.js';

const action = { pluginId: JIRA_PLUGIN_ID, localId: JIRA_ACTIONS.detail };
const commentAction = { pluginId: JIRA_PLUGIN_ID, localId: JIRA_ACTIONS.comment };
function Overview({ input }: { input: TriageDetailSurfaceInputV1 }): React.ReactElement {
    const text = usePluginTranslation();
    const request = useTriageDetailRequest(input);
    const { active, activeSignal } = useTabPanelActivity();
    const { execute } = useExecutePluginAction(action);
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const [settled, setSettled] = React.useState<{ request: typeof request; result: JiraDetailResult }>();
    React.useEffect(() => {
        if (!active || activeSignal.aborted) return;
        const controller = new AbortController();
        const abort = () => controller.abort();
        activeSignal.addEventListener('abort', abort);
        void execute({ v: 1, ...request }, { signal: controller.signal }).then((execution) => {
            if (controller.signal.aborted) return;
            const parsed = execution.status === 'success' ? JiraDetailResultSchema.safeParse(execution.result) : undefined;
            setSettled({ request, result: parsed?.success ? parsed.data
                : { kind: 'failed', failure: { class: 'transient', code: 'jira/detailUnavailable' } } });
        }).catch(() => {
            if (!controller.signal.aborted) setSettled({ request, result: { kind: 'failed', failure: { class: 'transient', code: 'jira/detailUnavailable' } } });
        });
        return () => { activeSignal.removeEventListener('abort', abort); controller.abort(); };
    }, [active, activeSignal, execute, request, attempt]);
    const result = settled?.request === request ? settled.result : undefined;
    if (!result) return <LoadingState title={text('plugins.jira.detail.loading', 'Reading Jira issue')} />;
    if (result.kind === 'failed') return <ErrorState title={describeTriageSourceFailureV1(result.failure, text('plugins.jira.detail.unavailable', 'Jira issue unavailable'), text)}
        action={<Button variant="secondary" title={text('plugins.jira.detail.retry', 'Retry')} onPress={retry} />} />;
    const webUrl = input.observation.locator.webUrl;
    return <TriageDetailStory>
        <Text value={result.body || text('plugins.jira.detail.noDescription', 'No description')} />
        <Metadata entries={result.fields} />
        <TriageSourceCommentComposer action={commentAction} sourceName="Jira" {...(webUrl === undefined ? {} : { sourceUrl: webUrl })}
            buildInput={(body) => {
                const entry = TriageSourceConnectedAccountInputsV1.get.safeParse({ v: 1, ...request });
                return entry.success ? { entry: entry.data, body } : null;
            }} internal={{ anchor: input.observation.entryRef }} />
    </TriageDetailStory>;
}
function JiraDetail(context: RenderContext): React.ReactElement {
    const text = usePluginTranslation();
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    if (!parsed.success) return <ErrorState title={text('plugins.jira.detail.unavailable', 'Jira issue unavailable')} />;
    return <TriageDetailInstance scrollOwner={parsed.data.panelScrollOwner}><TriageDetailPanel scrollOwner={parsed.data.panelScrollOwner} panel={parsed.data.panel ?? 'overview'} ariaLabel="Jira"
        panels={{ overview: <Overview input={parsed.data} /> }} /></TriageDetailInstance>;
}
export const renderSurface = defineUiSurface(JiraDetail);
