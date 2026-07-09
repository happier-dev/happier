export async function observeAgentResponse(event = {}) {
    return {
        observed: true,
        eventId: event.eventId ?? null
    };
}
