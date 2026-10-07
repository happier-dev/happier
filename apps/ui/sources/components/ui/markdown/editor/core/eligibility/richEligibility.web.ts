/**
 * Web rich-eligibility resolver.
 *
 * Demand-loads the shared web engine payload and injects its HTML round-trip
 * adapter (a throwaway `@tiptap/core` editor) into the pure evaluator so
 * HTML-containing markdown can be admitted when it round-trips losslessly
 * within budget.
 *
 * This is the ONLY `core/eligibility/` file allowed to demand the web engine
 * (it is resolved by Metro for web only, so `@tiptap/*` never enters the native
 * graph — R18). The signature mirrors `richEligibility.native.ts` exactly so
 * the platform split is type-consistent.
 */

import * as React from 'react';

import {
    evaluateMarkdownRichEligibility,
    type MarkdownRichEligibility,
} from './markdownRichEligibility';

export type ResolveRichEligibilityOptions = Readonly<{
    language: string | null;
    maxBytes: number;
    htmlRoundTripMaxBytes: number;
}>;

type RoundTripModule = Pick<typeof import('../../markdownEditorEngine.web'), 'getRichMarkdownRoundTripOutput'>;
let loadedRoundTrip: RoundTripModule | undefined;
let loadingRoundTrip: Promise<RoundTripModule> | undefined;

function loadRoundTrip(): Promise<RoundTripModule> {
    loadingRoundTrip ??= import('../../markdownEditorEngine.web').then((module) => {
        loadedRoundTrip = module;
        return module;
    }).catch((error: unknown) => {
        loadingRoundTrip = undefined;
        throw error;
    });
    return loadingRoundTrip;
}

/** Cheap gates stay synchronous; only HTML editing needs the web engine. */
export function useRichEligibility(raw: string, opts: ResolveRichEligibilityOptions): MarkdownRichEligibility {
    const cheap = React.useMemo(
        () => evaluateMarkdownRichEligibility(raw, {
            language: opts.language,
            maxBytes: opts.maxBytes,
            htmlRoundTripMaxBytes: opts.htmlRoundTripMaxBytes,
        }),
        [raw, opts.language, opts.maxBytes, opts.htmlRoundTripMaxBytes],
    );
    const needsRoundTrip = cheap.reason === 'html-or-jsx';
    const [module, setModule] = React.useState(() => loadedRoundTrip);
    const [failedText, setFailedText] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!needsRoundTrip || module) return;
        let cancelled = false;
        setFailedText(null);
        void loadRoundTrip().then((loaded) => {
            if (!cancelled) setModule(loaded);
        }).catch((error: unknown) => {
            console.error('Failed to load markdown HTML eligibility', error);
            if (!cancelled) setFailedText(raw);
        });
        return () => { cancelled = true; };
    }, [module, needsRoundTrip, raw]);

    return React.useMemo(() => {
        if (!needsRoundTrip) return cheap;
        if (!module) return { ...cheap, pending: failedText !== raw };
        return evaluateMarkdownRichEligibility(raw, {
            language: opts.language,
            maxBytes: opts.maxBytes,
            htmlRoundTripMaxBytes: opts.htmlRoundTripMaxBytes,
            htmlRoundTrip: module.getRichMarkdownRoundTripOutput,
        });
    }, [cheap, failedText, module, needsRoundTrip, raw, opts.language, opts.maxBytes, opts.htmlRoundTripMaxBytes]);
}
