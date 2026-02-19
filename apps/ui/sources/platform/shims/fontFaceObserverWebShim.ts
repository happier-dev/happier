type FontFaceObserverOptions = {
    style?: string;
    weight?: string | number;
    stretch?: string;
};

function createFontShorthand(
    family: string,
    style: string,
    weight: string | number,
    stretch: string
): string {
    const safeStretch = stretch && stretch !== 'normal' ? stretch : '';
    return [style, String(weight), safeStretch, '100px', `"${family}"`].filter(Boolean).join(' ');
}

/**
 * Web-only `fontfaceobserver` replacement.
 *
 * expo-font uses fontfaceobserver on web with a hard-coded timeout. When that timeout triggers,
 * the rejection can surface as an unhandled error (e.g. from @expo/vector-icons async lifecycle).
 *
 * This shim is intentionally fail-open:
 * - It triggers a native font load attempt when possible.
 * - It never rejects on timeout.
 */
export default class FontFaceObserver {
    private readonly family: string;
    private readonly style: string;
    private readonly weight: string | number;
    private readonly stretch: string;
    private readonly context: Window | undefined;

    public constructor(family: string, options: FontFaceObserverOptions = {}, context?: Window) {
        this.family = family;
        this.style = options.style ?? 'normal';
        this.weight = options.weight ?? 'normal';
        this.stretch = options.stretch ?? 'normal';
        this.context = context ?? (typeof window !== 'undefined' ? window : undefined);
    }

    public load(text?: string | null, timeoutMs?: number): Promise<FontFaceObserver> {
        const documentLike: Document | undefined =
            this.context?.document ?? (typeof document !== 'undefined' ? document : undefined);

        const fonts: FontFaceSet | undefined = documentLike?.fonts;
        const shorthand = createFontShorthand(this.family, this.style, this.weight, this.stretch);
        const loadText = text ?? 'BESbswy';

        const attemptLoad = (async () => {
            try {
                if (fonts && typeof fonts.load === 'function') {
                    await fonts.load(shorthand, loadText);
                }
            } catch {
                // Best-effort only.
            }
            return this;
        })();

        const resolvedAttempt = attemptLoad.catch(() => this);

        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return resolvedAttempt;
        }
        if (typeof setTimeout !== 'function') {
            return resolvedAttempt;
        }

        const timeoutPromise = new Promise<FontFaceObserver>((resolve) => {
            setTimeout(() => resolve(this), timeoutMs);
        });

        return Promise.race([resolvedAttempt, timeoutPromise]);
    }
}
