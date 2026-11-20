import React from 'react';
import { View } from 'react-native';
import { createQRMatrix } from './qrMatrix';

// Check if point is in a locator pattern area
function isInLocatorPattern(x: number, y: number, matrixSize: number): boolean {
    // Top-left pattern
    if (x < 7 && y < 7) return true;
    // Top-right pattern  
    if (x >= matrixSize - 7 && y < 7) return true;
    // Bottom-left pattern
    if (x < 7 && y >= matrixSize - 7) return true;
    return false;
}

// Generate SVG path string for rectangle with selective rounded corners
function getRectPath(x: number, y: number, w: number, h: number,
    tlr: number, trr: number, brr: number, blr: number): string {
    return `M ${x} ${y + tlr}
            A ${tlr} ${tlr} 0 0 1 ${x + tlr} ${y}
            L ${x + w - trr} ${y}
            A ${trr} ${trr} 0 0 1 ${x + w} ${y + trr}
            L ${x + w} ${y + h - brr}
            A ${brr} ${brr} 0 0 1 ${x + w - brr} ${y + h}
            L ${x + blr} ${y + h}
            A ${blr} ${blr} 0 0 1 ${x} ${y + h - blr}
            Z`;
}

// Keep the finder ring in foreground geometry so transparent quiet zones cannot erase it.
function getLocatorRingPath(x: number, y: number, moduleSize: number, baseRadius: number): string {
    const outerRadius = moduleSize * (baseRadius + 1);
    const innerRadius = moduleSize * baseRadius;
    const outer = getRectPath(
        x,
        y,
        7 * moduleSize,
        7 * moduleSize,
        outerRadius,
        outerRadius,
        outerRadius,
        outerRadius,
    );
    const inner = getRectPath(
        x + moduleSize,
        y + moduleSize,
        5 * moduleSize,
        5 * moduleSize,
        innerRadius,
        innerRadius,
        innerRadius,
        innerRadius,
    );
    return `${outer} ${inner}`;
}

interface QRCodeProps {
    data: string;
    size?: number;
    errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high';
    /**
     * Leave a two-module margin inside `size` (default). A caller whose own paper already gives the code its quiet
     * zone turns it off, so the modules fill the size instead of shrinking by a margin nobody sees.
     */
    quietZone?: boolean;
    /**
     * Pixels the code may spill past `size` on each side, into a quiet zone its paper draws around it, so a code a
     * few pixels too wide for whole-pixel modules keeps the larger module instead of halving it.
     */
    bleed?: number;
    foregroundColor?: string;
    backgroundColor?: string;
}

export const QRCode = React.memo((props: QRCodeProps) => {
    const {
        data,
        size = 200,
        errorCorrectionLevel = 'medium',
        foregroundColor = '#000000',
        backgroundColor = '#FFFFFF',
        quietZone = true,
        bleed = 0,
    } = props;
    const margin = quietZone ? 4 : 0;

    // Generate QR matrix
    const qrMatrix = React.useMemo(() => {
        return createQRMatrix(data, errorCorrectionLevel);
    }, [data, errorCorrectionLevel]);

    // One module is a whole number of device pixels, and the code sits centred on the pixel grid,
    // so edges stay sharp at any size (a 72 px store code smeared when modules were fractional and
    // overlapped their neighbours by a pixel to hide antialiasing seams).
    const pixelRatio = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const moduleSize = Math.max(1, Math.floor(((size + 2 * bleed) * pixelRatio) / (qrMatrix.size + margin))) / pixelRatio;
    const origin = Math.round(((size - moduleSize * qrMatrix.size) / 2) * pixelRatio) / pixelRatio;

    // Generate modules with rounded corners
    const modules = React.useMemo(() => {
        const elements: React.ReactElement[] = [];

        for (let y = 0; y < qrMatrix.size; y++) {
            for (let x = 0; x < qrMatrix.size; x++) {
                // Skip locator pattern areas
                if (isInLocatorPattern(x, y, qrMatrix.size)) continue;

                const neighbors = qrMatrix.getNeighbors(x, y);

                if (neighbors.current) {
                    let tlr = 0, trr = 0, brr = 0, blr = 0;
                    const cornerRadius = Math.min(moduleSize / 3, size * 0.01);

                    // Calculate rounded corners (using corrected logic from mobile)
                    if (!neighbors.top && !neighbors.left) tlr = cornerRadius;    // top-left
                    if (!neighbors.top && !neighbors.right) blr = cornerRadius;   // bottom-left
                    if (!neighbors.bottom && !neighbors.left) trr = cornerRadius; // top-right
                    if (!neighbors.bottom && !neighbors.right) brr = cornerRadius; // bottom-right

                    // Use path if any corner is rounded
                    if (tlr || trr || brr || blr) {
                        const pathData = getRectPath(
                            origin + x * moduleSize,
                            origin + y * moduleSize,
                            moduleSize,
                            moduleSize,
                            tlr, trr, brr, blr
                        );

                        elements.push(
                            <path
                                key={`${x}-${y}`}
                                d={pathData}
                                fill={foregroundColor}
                            />
                        );
                    } else {
                        // Use simple rect for modules with no rounded corners
                        elements.push(
                            <rect
                                key={`${x}-${y}`}
                                x={origin + x * moduleSize}
                                y={origin + y * moduleSize}
                                width={moduleSize}
                                height={moduleSize}
                                fill={foregroundColor}
                            />
                        );
                    }
                }
            }
        }

        return elements;
    }, [qrMatrix, moduleSize, origin, foregroundColor]);

    const baseRadius = 0.5;

    return (
        <View
            style={{
                width: size,
                height: size,
            }}
        >
            <svg
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                style={{ display: 'block', borderRadius: moduleSize, overflow: bleed > 0 ? 'visible' : undefined }}
            >
                {/* Background */}
                <rect
                    x={0}
                    y={0}
                    width={size}
                    height={size}
                    fill={backgroundColor}
                />

                {/* QR modules with rounded corners */}
                {modules}

                {/* Top-left locator pattern */}
                <path
                    d={getLocatorRingPath(origin, origin, moduleSize, baseRadius)}
                    fill={foregroundColor}
                    fillRule="evenodd"
                />
                <rect
                    x={origin + 2 * moduleSize}
                    y={origin + 2 * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    rx={moduleSize}
                    ry={moduleSize}
                    fill={foregroundColor}
                />

                {/* Top-right locator pattern */}
                <path
                    d={getLocatorRingPath(origin + (qrMatrix.size - 7) * moduleSize, origin, moduleSize, baseRadius)}
                    fill={foregroundColor}
                    fillRule="evenodd"
                />
                <rect
                    x={origin + (qrMatrix.size - 7 + 2) * moduleSize}
                    y={origin + 2 * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    rx={moduleSize}
                    ry={moduleSize}
                    fill={foregroundColor}
                />

                {/* Bottom-left locator pattern */}
                <path
                    d={getLocatorRingPath(origin, origin + (qrMatrix.size - 7) * moduleSize, moduleSize, baseRadius)}
                    fill={foregroundColor}
                    fillRule="evenodd"
                />
                <rect
                    x={origin + 2 * moduleSize}
                    y={origin + (qrMatrix.size - 7 + 2) * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    rx={moduleSize}
                    ry={moduleSize}
                    fill={foregroundColor}
                />
            </svg>
        </View>
    );
});
