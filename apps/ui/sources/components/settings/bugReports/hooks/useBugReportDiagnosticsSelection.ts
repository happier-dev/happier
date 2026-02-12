import * as React from 'react';

import type { BugReportsFeature } from '../bugReportFeatureDefaults';

export function useBugReportDiagnosticsSelection(feature: BugReportsFeature): {
  includeDiagnostics: boolean;
  setIncludeDiagnostics: (value: boolean) => void;
  diagnosticsKinds: string[];
  setDiagnosticsKinds: (kinds: string[]) => void;
} {
  const includeDiagnosticsTouched = React.useRef(false);
  const diagnosticsKindsTouched = React.useRef(false);

  const [includeDiagnostics, setIncludeDiagnosticsState] = React.useState(feature.defaultIncludeDiagnostics);
  const [diagnosticsKinds, setDiagnosticsKindsState] = React.useState<string[]>(feature.acceptedArtifactKinds);

  React.useEffect(() => {
    if (!includeDiagnosticsTouched.current) {
      setIncludeDiagnosticsState(feature.defaultIncludeDiagnostics);
    }
  }, [feature.defaultIncludeDiagnostics]);

  React.useEffect(() => {
    const accepted = feature.acceptedArtifactKinds;
    if (!diagnosticsKindsTouched.current) {
      setDiagnosticsKindsState(accepted);
      return;
    }
    // Keep user selection, but don't allow selecting kinds the server doesn't accept.
    setDiagnosticsKindsState((current) => current.filter((kind) => accepted.includes(kind)));
  }, [feature.acceptedArtifactKinds]);

  const setIncludeDiagnostics = React.useCallback((value: boolean) => {
    includeDiagnosticsTouched.current = true;
    setIncludeDiagnosticsState(value);
  }, []);

  const setDiagnosticsKinds = React.useCallback((nextKinds: string[]) => {
    diagnosticsKindsTouched.current = true;
    const accepted = feature.acceptedArtifactKinds;
    const filtered = Array.from(new Set(nextKinds)).filter((kind) => accepted.includes(kind));
    if (filtered.length === 0) {
      // Avoid having "include diagnostics" enabled but no selected sources.
      includeDiagnosticsTouched.current = true;
      setIncludeDiagnosticsState(false);
    }
    setDiagnosticsKindsState(filtered);
  }, [feature.acceptedArtifactKinds]);

  return {
    includeDiagnostics,
    setIncludeDiagnostics,
    diagnosticsKinds,
    setDiagnosticsKinds,
  };
}
