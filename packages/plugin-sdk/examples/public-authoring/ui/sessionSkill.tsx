import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    Action,
    Button,
    ErrorState,
    HappierSavedSkillCard,
    Stack,
    Text,
    TextField,
    useExecutePluginAction,
} from '@happier-dev/plugin-ui';

export const SESSION_SKILL_REFERENCE_VIEW_ID = 'session-skill-reference';

/** An explicit library read in the existing Session slot; the host owns all Action admission. */
export function SessionSkillReference({ context }: Readonly<{ context: RenderContext }>) {
    const [skillId, setSkillId] = React.useState('');
    const { execution, execute, pendingApproval } = useExecutePluginAction('skills.read');
    const target = context.surface.target;
    if (target.kind !== 'session') {
        return <ErrorState title="Open this view from a Session" />;
    }
    const input = { skillId, sessionId: target.sessionId };
    return <Stack gap="small">
        <TextField label="Skill id" value={skillId} onChange={setSkillId} />
        <Button title={pendingApproval ? 'Waiting for approval' : 'Read skill'}
            disabled={!skillId.trim() || pendingApproval !== null || execution.status === 'pending'}
            onPress={() => execute(input, { signal: context.signal })} />
        {pendingApproval ? <Text value="Waiting for approval" /> : null}
        {execution.status === 'pending' ? <Text value="Reading skill" /> : null}
        {execution.status === 'error' || execution.status === 'outcomeUnknown'
            ? <ErrorState title="Skill unavailable" description={execution.message} /> : null}
        {execution.status === 'success' ? <>
            <HappierSavedSkillCard testID="example.session-skill" name={execution.result.name}
                description={null} savedLabel="In your library" status="Runtime application not inspected"
                viewControl={<Action.Copy value={execution.result.skillMd} title="Copy instructions" />} />
            <Text value={execution.result.skillMd} selectable />
        </> : null}
    </Stack>;
}
