/** The composer text an AgentInput element is given: a string, or the live text source its text leaf subscribes to. */
export function readComposerText(agentInput: Readonly<{ props: Readonly<{ value?: unknown }> }>): unknown {
    const { value } = agentInput.props;
    return typeof value === 'object' && value !== null && 'getPrompt' in value && typeof value.getPrompt === 'function'
        ? value.getPrompt()
        : value;
}
