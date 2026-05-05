export async function observeProviderResponse(event = {}) {
    return {
        observed: true,
        eventId: event.eventId ?? null
    };
}
