export const VOICE_RUNTIME_CONFIG_DEFAULTS = {
    listeningStartTimeoutMs: 5_000,
    realtimeConversationHandleReadyTimeoutMs: 500,
    realtimeStartAbortGraceMs: 1_000,
    realtimeWatchdogPollMs: 3_000,
    realtimeWatchdogPlateauMs: 10_000,
    daemonInference: {
        warmIdleEvictMs: 5 * 60 * 1000,
        warmOnVoiceHomeAttach: true,
        perModelConcurrency: 1,
        statusPollMs: 750,
        tts: {
            defaultCodec: {
                codec: 'wav',
                mimeType: 'audio/wav',
            },
            latencyBudgetMs: 2_000,
            consecutiveSlowCallsBeforeDemotion: 2,
        },
        stt: {
            maxUploadBytes: 25 * 1024 * 1024,
            acceptedInputFormats: [
                'audio/wav',
                'audio/wave',
                'audio/x-wav',
                'audio/mp4',
                'audio/x-m4a',
                'audio/webm',
                'audio/mpeg',
                'audio/mp3',
                'audio/ogg',
                'audio/opus',
                'audio/x-caf',
                'audio/3gpp',
            ],
        },
    },
} as const;
