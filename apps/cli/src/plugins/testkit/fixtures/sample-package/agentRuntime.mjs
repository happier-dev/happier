export const sampleAgentRuntimeFactory = () => ({
    sessions: {
        async open(request) {
            let listener = null;
            return {
                async send(input) {
                    listener?.({
                        kind: 'input-accepted',
                        turnId: input.delivery.turnId,
                    });
                    return { status: 'admitted' };
                },
                watch(nextListener) {
                    listener = nextListener;
                    return {
                        dispose() {
                            if (listener === nextListener) listener = null;
                        },
                    };
                },
                async dispose() {
                    listener = null;
                },
                sessionId: request.sessionId,
            };
        },
    },
});
