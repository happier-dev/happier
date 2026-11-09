import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

const input = { sessionId: 'coordinator', view: 'recap' } satisfies PluginActionInputById['session.activity.get'];
declare const result: PluginActionResultById['session.activity.get'];
if ('view' in result && result.view === 'recap') {
    if (result.status === 'ready') {
        const text: string = result.recap.text;
        if (result.recap.source === 'worker_update') {
            const body: string | undefined = result.recap.body;
            const sender: string | undefined = result.recap.workerSessionId;
            void [body, sender];
        }
        void text;
    } else {
        const absent: null = result.recap;
        const status: 'loading' | 'empty' | 'unavailable' = result.status;
        void [absent, status];
    }
}
void input;
