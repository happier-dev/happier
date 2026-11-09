/** Native-side playback only. Rows retain their recorded order; refusals below
 * are constructed from Muse 1.4.14's native schema, not observed error captures. */
export const MUSE_MSP_DECISION_PLAYBACK = String.raw`
function createDecisionPlayback(recording, scenario) {
    const slices = {
        'approval-abort': { turnStart: 11, decide: 24, terminal: 44, kind: 'approval' },
        'approval-allow-once': { turnStart: 12, decide: 25, terminal: 48, kind: 'approval' },
        // Explicit cross-capture composition: advanced startup plus lifecycle's
        // first approval. Persistence and the alternate outcome are synthetic.
        'approval-local-persistent': { turnStart: 6, decide: 19, terminal: 42, kind: 'approval' },
        'question-single-choice': { turnStart: 45, decide: 57, terminal: 77, kind: 'userInput' },
    };
    const selected = slices[scenario];
    if (!selected) throw new Error('Unknown native playback scenario');
    const rows = recording.rows;
    const recordedTurn = rows[selected.turnStart].message;
    const recordedDecision = rows[selected.decide].message;
    const request = rows.slice(selected.turnStart, selected.decide)
        .find(row => row.direction === 'recv' && row.message?.method === selected.kind + '/request').message;
    let expected = recordedDecision.params;
    let offeredChoices = request.params.availableChoices;
    const identities = new Map();
    let receiptCount = 0;
    let decisionCount = 0;
    let released = false;
    let persistentChoice;
    const policyPath = process.env.MUSE_TEST_POLICY_PATH;
    function remap(value) {
        if (typeof value === 'string') return identities.get(value) || value;
        if (Array.isArray(value)) return value.map(remap);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)]));
        return value;
    }
    function refuse(message, code, kind) {
        return [{ jsonrpc: '2.0', id: message.id, error: { code,
            message: 'Input does not match the native playback scenario', data: { kind, retryable: false } } }];
    }
    function unsupportedVector(message) {
        return [{ jsonrpc: '2.0', id: message.id, error: { code: -32603,
            message: 'Playback has no recording of this valid alternate choice', data: { fixtureUnsupportedVector: true } } }];
    }
    function capturedRange(from, until, originalId, currentId) {
        return rows.slice(from, until).filter(row => row.direction === 'recv').map(row => {
            const value = remap(row.message);
            if (persistentChoice && value.method === 'approval/resolved') value.params.decision = persistentChoice.decision;
            return value.id === originalId && !value.method ? { ...value, id: currentId } : value;
        });
    }
    return {
        inspect() { return { receiptCount, decisionCount, released }; },
        observe(message) {
            if (selected.kind === 'approval' && message.method === 'approval/updated'
                && message.params.approvalId === expected.approvalId) {
                expected = { ...expected, requirementId: message.params.currentRequirementId };
                offeredChoices = message.params.availableChoices;
            }
        },
        handle(message) {
            if (!message.method) {
                if (message.id === request.id && message.result && Object.keys(message.result).length === 0) receiptCount++;
                return []; // Receipt is presentation only; native work remains parked.
            }
            if (message.method === 'turn/start') {
                identities.set(recordedTurn.params.commandId, message.params.commandId);
                if (scenario === 'approval-local-persistent' && require('node:fs').existsSync(policyPath)) {
                    const policy = JSON.parse(require('node:fs').readFileSync(policyPath, 'utf8'));
                    if (policy.command === request.params.subject.command) {
                        released = true;
                        return [
                            ...capturedRange(selected.turnStart + 1, selected.decide, recordedTurn.id, message.id)
                                .filter(value => value.method !== 'approval/request' && value.method !== 'approval/requested'),
                            ...capturedRange(selected.decide + 1, selected.terminal + 1)
                                .filter(value => value.method && value.method !== 'approval/resolved'),
                        ];
                    }
                }
                return capturedRange(selected.turnStart + 1, selected.decide, recordedTurn.id, message.id);
            }
            if (message.method !== recordedDecision.method) return undefined;
            const params = message.params;
            if (!params) return refuse(message, -32602, 'invalidParams');
            if (params.sessionId !== expected.sessionId) return refuse(message, -32024, 'sessionNotLoaded');
            if (selected.kind === 'approval') {
                if (params.approvalId !== expected.approvalId) return refuse(message, -32050, 'approvalNotFound');
                if (released) return refuse(message, -32051, 'approvalAlreadyResolved');
                if (params.requirementId?.approvalId !== expected.requirementId.approvalId
                    || params.requirementId?.sourceIndex !== expected.requirementId.sourceIndex) {
                    return refuse(message, -32053, 'approvalRequirementStale');
                }
                if (!offeredChoices.some(choice => choice.choiceId === params.choiceId)) {
                    return refuse(message, -32052, 'approvalChoiceInvalid');
                }
                const choice = offeredChoices.find(choice => choice.choiceId === params.choiceId);
                if (scenario === 'approval-local-persistent' && choice.scope === 'localPersistent') {
                    persistentChoice = choice;
                    require('node:fs').writeFileSync(policyPath, JSON.stringify({ command: request.params.subject.command,
                        choiceId: choice.choiceId, scope: choice.scope, rulePreview: choice.rulePreview }));
                } else if (params.choiceId !== expected.choiceId) return unsupportedVector(message);
            } else {
                if (params.userInputId !== expected.userInputId) return refuse(message, -32055, 'userInputNotFound');
                if (released) return refuse(message, -32056, 'userInputAlreadySettled');
                const answer = params.answers?.[0];
                if (!Array.isArray(params.answers) || params.answers.length !== 1 || answer?.questionId !== expected.answers[0].questionId
                    || !request.params.questions[0].options.some(option => option.label === answer.selectedLabel)
                    || (typeof answer.note === 'string' && Array.from(answer.note).length > 500)
                    || (typeof answer.freeText === 'string' && Array.from(answer.freeText).length > 500)) {
                    return refuse(message, -32057, 'userInputAnswerInvalid');
                }
                if (answer.selectedLabel !== expected.answers[0].selectedLabel || answer.freeText !== undefined || answer.selectedLabels !== undefined) {
                    return unsupportedVector(message);
                }
            }
            identities.set(expected.commandId, params.commandId);
            decisionCount++;
            released = true;
            return capturedRange(selected.decide + 1, selected.terminal + 1, recordedDecision.id, message.id);
        },
    };
}
`;
