import * as React from 'react';

// Screen-only captures let the real SessionView own its safe-area spacing.
// The normal framed stage continues to own that spacing outside the screen.
export const StagePhoneCaptureContext = React.createContext(false);
