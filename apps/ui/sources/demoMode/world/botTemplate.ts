import { BotTemplateDraftV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { DEMO_RICH_SESSION_ID, DEMO_SERVER_BASE_URL } from './constants';

export function buildDemoBotTemplate() {
    return BotTemplateDraftV1Schema.parse({
        v: 1, state: 'draft',
        sourceSessionRef: { serverId: DEMO_SERVER_BASE_URL, sessionId: DEMO_RICH_SESSION_ID },
        releaseArtifactId: 'c454c273-28c7-450e-bc76-b7b2bb70f833',
        content: {
            v: 1,
            identity: {
                name: 'Scout', description: 'A thoughtful reviewer for Northstar. Finds the risks, keeps the team moving.',
                face: { style: 'dither', body: 'crab', palette: 'daybreak' },
                madeFromName: 'Northstar auth review',
            },
            instructions: { markdown: 'Review changes for correctness, accessibility and a clear path back. Explain the risk with a concrete example. Ask Maya before changing shared infrastructure.' },
            firstTask: 'Review the sign-in changes and bring the two most useful findings to our discussion.',
            memoryRules: [{ key: 'review', text: 'Keep review comments specific and kind.', topic: 'Working together' }],
            skills: [{ key: 'review', title: 'Thoughtful code review', bundleSchemaId: 'skills.skill_md_v1',
                entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(
                    '---\nname: thoughtful-review\ndescription: Review a change for correctness and clarity.\n---\n\nRead the change, trace its callers, and explain concrete risks with a useful next step.\n',
                )) }] }],
            needs: { software: [], connectedAccounts: [{ key: 'github', name: 'GitHub', requirement: 'required',
                serviceId: 'github', purpose: 'Read the pull request and its checks.', skipConsequence: '' }], mcpServers: [] },
            suggestedAgent: { agentId: 'claude' },
        },
        candidates: { skills: [], memoryRules: [] },
    });
}
