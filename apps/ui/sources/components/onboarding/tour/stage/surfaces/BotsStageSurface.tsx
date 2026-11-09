import * as React from 'react';

import { BotTemplateEditorBody } from '@/components/sessions/bots/templates/BotTemplateEditor';
import { createBotTemplateEditorBuffer } from '@/components/sessions/bots/templates/botTemplateEditorBuffer';
import { buildDemoBotTemplate } from '@/demoMode/world/botTemplate';
import { DEMO_SERVER_BASE_URL } from '@/demoMode/world/constants';

export function BotsStageSurface() {
    const [buffer] = React.useState(() => createBotTemplateEditorBuffer({
        draft: buildDemoBotTemplate(), revision: { headerVersion: 1, bodyVersion: 1 },
    }));
    return <BotTemplateEditorBody artifactId="e6f45927-98a5-439f-8b18-02abcf514402" serverId={DEMO_SERVER_BASE_URL}
        presentation="page" buffer={buffer}
        scope={{ serverId: DEMO_SERVER_BASE_URL, accountId: 'demo-account-maya' }}
        save={async () => ({ ok: false, code: 'demo_readonly' })}
        execute={async () => ({ ok: false, errorCode: 'demo_readonly', error: 'demo_readonly' })} />;
}
