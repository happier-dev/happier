import * as React from 'react';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';
import type { BotTemplateEditorBuffer, BotTemplateSave } from './botTemplateEditorBuffer';

/** Save the private draft before opening the existing publisher; opening is not a release. */
export function BotTemplatePublishButton(props: Readonly<{
    artifactId: string; serverId: string; buffer: BotTemplateEditorBuffer; save: BotTemplateSave;
}>) {
    const router = useRouter();
    const [saving, setSaving] = React.useState(false);
    const open = async () => {
        if (saving) return false;
        setSaving(true);
        try {
            await props.buffer.commit(props.save);
            if (props.buffer.getSnapshot().status !== 'saved') return false;
            router.pushRetainingCurrent({ pathname: '/settings/plugins/publish',
                params: { templateArtifactId: props.artifactId, templateServerId: props.serverId } } as never);
            return true;
        } finally { setSaving(false); }
    };
    const title = t('botTemplates.publishEllipsis');
    useCurrentUiContextLocalCommands([{ key: 'bot-template.publish', title, invoke: open }]);
    return <RoundButton testID="bot-template-publish" title={title} display="secondary" size="normal"
        loading={saving} disabled={saving} onPress={() => { void open(); }} />;
}
