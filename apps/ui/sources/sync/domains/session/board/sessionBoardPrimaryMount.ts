/** The surface rendering a Session visual; content and demand remain surface-local. */
export type SessionBoardMountHost =
    | 'focusedDetails'
    | 'details'
    | 'mobileCockpit'
    | 'companion'
    | 'sidebar'
    | 'inlineTranscript';

export type SessionBoardMountMode =
    | 'executable'
    | 'preview'
    | 'inert';
