/** The existing OpenAI API-key service, also usable outside Voice. */
export const OPENAI_CONNECTED_ACCOUNT_SERVICE = Object.freeze({ pluginId: 'happier.voice.openai', localId: 'openai' } as const);
export const OPENAI_SELECTED_API_KEY_ENV = 'HAPPIER_CONNECTED_OPENAI_API_KEY';
