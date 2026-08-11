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

// Compound even-odd path for a locator ring: outer 7x7 rounded square with the
// inner 5x5 punched out. The ring is painted purely in the foreground color so
// a transparent background cannot erase it (mirrors DiffRect in QRCode.tsx).
function getLocatorRingPath(x: number, y: number, moduleSize: number, baseRadius: number): string {
    const outerRadius = moduleSize * (baseRadius + 1);
    const innerRadius = moduleSize * baseRadius;
    const outer = getRectPath(x, y, 7 * moduleSize, 7 * moduleSize,
        outerRadius, outerRadius, outerRadius, outerRadius);
    const inner = getRectPath(x + moduleSize, y + moduleSize, 5 * moduleSize, 5 * moduleSize,
        innerRadius, innerRadius, innerRadius, innerRadius);
    return `${outer} ${inner}`;
}

interface QRCodeProps {
    data: string;
    size?: number;
    errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high';
    foregroundColor?: string;
    backgroundColor?: string;
}

export const QRCode = React.memo((props: QRCodeProps) => {
    const {
        data,
        size = 200,
        errorCorrectionLevel = 'medium',
        foregroundColor = '#000000',
        backgroundColor = '#FFFFFF'
    } = props;

    // Generate QR matrix
    const qrMatrix = React.useMemo(() => {
        return createQRMatrix(data, errorCorrectionLevel);
    }, [data, errorCorrectionLevel]);

    // Calculate module size
    const moduleSize = size / (qrMatrix.size + 4/* space around */);

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
                            x * moduleSize - 0.5 + 2 * moduleSize,
                            y * moduleSize - 0.5 + 2 * moduleSize,
                            moduleSize + 1,
                            moduleSize + 1,
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
                                x={x * moduleSize - 0.5 + 2 * moduleSize}
                                y={y * moduleSize - 0.5 + 2 * moduleSize}
                                width={moduleSize + 1}
                                height={moduleSize + 1}
                                fill={foregroundColor}
                            />
                        );
                    }
                }
            }
        }

        return elements;
    }, [qrMatrix, moduleSize, foregroundColor]);

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
                style={{ display: 'block', borderRadius: moduleSize }}
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
                    d={getLocatorRingPath(2 * moduleSize, 2 * moduleSize, moduleSize, baseRadius)}
                    fill={foregroundColor}
                    fillRule="evenodd"
                />
                <rect
                    x={4 * moduleSize}
                    y={4 * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    rx={moduleSize}
                    ry={moduleSize}
                    fill={foregroundColor}
                />

                {/* Top-right locator pattern */}
                <path
                    d={getLocatorRingPath((qrMatrix.size - 7 + 2) * moduleSize, 2 * moduleSize, moduleSize, baseRadius)}
                    fill={foregroundColor}
                    fillRule="evenodd"
                />
                <rect
                    x={(qrMatrix.size - 7 + 2 + 2) * moduleSize}
                    y={4 * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    rx={moduleSize}
                    ry={moduleSize}
                    fill={foregroundColor}
                />

                {/* Bottom-left locator pattern */}
                <path
                    d={getLocatorRingPath(2 * moduleSize, (qrMatrix.size - 7 + 2) * moduleSize, moduleSize, baseRadius)}
                    fill={foregroundColor}
                    fillRule="evenodd"
                />
                <rect
                    x={4 * moduleSize}
                    y={(qrMatrix.size - 7 + 2 + 2) * moduleSize}
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