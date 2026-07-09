export type LegendListRuntimeModelRow = Readonly<{
    key: string;
    heightPx: number;
}>;

export type LegendListRuntimeMaintainVisibleContentPosition = Readonly<{
    data: boolean;
    size: boolean;
}>;

export type LegendListRuntimeModelOptions = Readonly<{
    alignItemsAtEnd?: boolean;
    initialScrollAtEnd?: boolean;
    layoutHeightPx: number;
    maintainScrollAtEnd?: boolean;
    maintainScrollAtEndThresholdRatio?: number;
    maintainVisibleContentPosition?: LegendListRuntimeMaintainVisibleContentPosition;
    rows?: readonly LegendListRuntimeModelRow[];
}>;

export type LegendListRuntimeModelObservation = Readonly<{
    alignItemsAtEnd: boolean;
    contentHeightPx: number;
    dataOrder: 'oldest-first';
    distanceFromEndPx: number;
    initialScrollAtEnd: boolean;
    layoutHeightPx: number;
    orientation: 'standard';
    rawOffsetY: number;
}>;

const EPSILON_PX = 1;

function clampOffset(offset: number, maxScrollableExtent: number): number {
    if (!Number.isFinite(offset)) return 0;
    return Math.max(0, Math.min(offset, maxScrollableExtent));
}

export class LegendListRuntimeModel {
    private rows: LegendListRuntimeModelRow[];
    private readonly alignItemsAtEnd: boolean;
    private readonly initialScrollAtEnd: boolean;
    private readonly maintainScrollAtEnd: boolean;
    private readonly maintainScrollAtEndThresholdRatio: number;
    private readonly maintainVisibleContentPosition: LegendListRuntimeMaintainVisibleContentPosition;
    private readonly layoutHeightPx: number;
    private rawOffsetY = 0;
    private firstVisibleItemKey: string | null = null;
    private firstVisibleItemTopPx = 0;

    constructor(options: LegendListRuntimeModelOptions) {
        this.rows = [...(options.rows ?? [])];
        this.alignItemsAtEnd = options.alignItemsAtEnd === true;
        this.initialScrollAtEnd = options.initialScrollAtEnd === true;
        this.maintainScrollAtEnd = options.maintainScrollAtEnd === true;
        this.maintainScrollAtEndThresholdRatio = options.maintainScrollAtEndThresholdRatio ?? 0.1;
        this.layoutHeightPx = options.layoutHeightPx;
        this.maintainVisibleContentPosition = options.maintainVisibleContentPosition ?? { data: false, size: true };
        if (this.initialScrollAtEnd) {
            this.rawOffsetY = this.maxScrollableExtent();
        }
        this.captureFirstVisibleAnchor();
    }

    private contentHeightPx(): number {
        let total = 0;
        for (const row of this.rows) total += row.heightPx;
        return total;
    }

    private maxScrollableExtent(): number {
        return Math.max(0, this.contentHeightPx() - this.layoutHeightPx);
    }

    private distanceFromEndPx(): number {
        return Math.max(0, this.maxScrollableExtent() - this.rawOffsetY);
    }

    private maintainScrollAtEndThresholdPx(): number {
        return Math.max(0, this.maintainScrollAtEndThresholdRatio * this.layoutHeightPx);
    }

    private topOfIndex(index: number): number {
        let top = this.alignItemsAtEnd ? Math.max(0, this.layoutHeightPx - this.contentHeightPx()) : 0;
        for (let i = 0; i < index; i += 1) top += this.rows[i]?.heightPx ?? 0;
        return top;
    }

    private indexOfKey(key: string): number {
        return this.rows.findIndex((row) => row.key === key);
    }

    private firstVisibleIndex(): number {
        let bestIndex = 0;
        let bestTop = -Infinity;
        for (let index = 0; index < this.rows.length; index += 1) {
            const top = this.topOfIndex(index);
            if (top <= this.rawOffsetY + EPSILON_PX && top > bestTop) {
                bestIndex = index;
                bestTop = top;
            }
        }
        return bestIndex;
    }

    private captureFirstVisibleAnchor(): void {
        const index = this.firstVisibleIndex();
        const row = this.rows[index];
        if (!row) {
            this.firstVisibleItemKey = null;
            this.firstVisibleItemTopPx = 0;
            return;
        }
        this.firstVisibleItemKey = row.key;
        this.firstVisibleItemTopPx = this.topOfIndex(index);
    }

    private applyVisibleContentPositionCorrection(): number {
        if (!this.maintainVisibleContentPosition.data || !this.maintainVisibleContentPosition.size) {
            this.captureFirstVisibleAnchor();
            return 0;
        }
        if (!this.firstVisibleItemKey) return 0;
        const index = this.indexOfKey(this.firstVisibleItemKey);
        if (index < 0) {
            this.captureFirstVisibleAnchor();
            return 0;
        }
        const nextTop = this.topOfIndex(index);
        const diff = nextTop - this.firstVisibleItemTopPx;
        if (diff !== 0) {
            this.rawOffsetY = clampOffset(this.rawOffsetY + diff, this.maxScrollableExtent());
        }
        this.firstVisibleItemTopPx = nextTop;
        return diff;
    }

    observe(): LegendListRuntimeModelObservation {
        return {
            alignItemsAtEnd: this.alignItemsAtEnd,
            contentHeightPx: this.contentHeightPx(),
            dataOrder: 'oldest-first',
            distanceFromEndPx: this.distanceFromEndPx(),
            initialScrollAtEnd: this.initialScrollAtEnd,
            layoutHeightPx: this.layoutHeightPx,
            orientation: 'standard',
            rawOffsetY: this.rawOffsetY,
        };
    }

    onScreenTopOfRow(key: string): number | null {
        const index = this.indexOfKey(key);
        if (index < 0) return null;
        return this.topOfIndex(index) - this.rawOffsetY;
    }

    prependOlder(olderRows: readonly LegendListRuntimeModelRow[]): number {
        this.captureFirstVisibleAnchor();
        this.rows = [...olderRows, ...this.rows];
        return this.applyVisibleContentPositionCorrection();
    }

    appendNewer(newerRows: readonly LegendListRuntimeModelRow[]): void {
        const shouldFollowEnd =
            this.maintainScrollAtEnd &&
            this.distanceFromEndPx() <= this.maintainScrollAtEndThresholdPx();
        this.rows = [...this.rows, ...newerRows];
        this.rawOffsetY = shouldFollowEnd
            ? this.maxScrollableExtent()
            : clampOffset(this.rawOffsetY, this.maxScrollableExtent());
        this.captureFirstVisibleAnchor();
    }

    resizeRow(key: string, heightPx: number): number {
        const index = this.indexOfKey(key);
        if (index < 0 || !Number.isFinite(heightPx) || heightPx < 0) return 0;
        this.captureFirstVisibleAnchor();
        this.rows[index] = { ...this.rows[index], heightPx };
        return this.applyVisibleContentPositionCorrection();
    }

    userScrollBy(deltaPx: number): void {
        this.rawOffsetY = clampOffset(this.rawOffsetY + deltaPx, this.maxScrollableExtent());
        this.captureFirstVisibleAnchor();
    }

    scrollToEnd(): void {
        this.rawOffsetY = this.maxScrollableExtent();
        this.captureFirstVisibleAnchor();
    }

    scrollToIndex(params: Readonly<{ index: number; viewPosition?: number }>): Readonly<{ appliedOffsetY: number; index: number }> {
        const index = Math.max(0, Math.min(params.index, Math.max(0, this.rows.length - 1)));
        const viewPosition = params.viewPosition ?? 0;
        this.rawOffsetY = clampOffset(this.topOfIndex(index) - viewPosition * this.layoutHeightPx, this.maxScrollableExtent());
        this.captureFirstVisibleAnchor();
        return { appliedOffsetY: this.rawOffsetY, index };
    }
}

export function createLegendListRuntimeModel(options: LegendListRuntimeModelOptions): LegendListRuntimeModel {
    return new LegendListRuntimeModel(options);
}
