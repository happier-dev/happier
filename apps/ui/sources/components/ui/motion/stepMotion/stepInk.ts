import type { StepGrid } from './stepMotionTypes';

// Two CSS pixels per sample lets a stroke contribute to coverage even if it misses the cell centre.
export const stepInkSampleScale = 0.5;

export function stepInkGrid(grid: StepGrid) {
    const cellWidth = grid.cell[0] * stepInkSampleScale;
    const cellHeight = grid.cell[1] * stepInkSampleScale;
    return { cellWidth, cellHeight, width: grid.cols * cellWidth, height: grid.rows * cellHeight };
}

export function stepInkCoverage(grid: StepGrid, readPixel: (x: number, y: number) => number) {
    const { cellWidth, cellHeight } = stepInkGrid(grid);
    const { cols, rows } = grid;
    const rgba = new Uint8Array(cols * rows * 4);
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            let coverage = 0;
            const top = row * cellHeight;
            const left = col * cellWidth;
            for (let y = top; y < top + cellHeight; y++) {
                for (let x = left; x < left + cellWidth; x++) coverage += readPixel(x, y);
            }
            // A narrow pencil stroke should still read as a digit. Zero paint stays exactly zero.
            rgba[(row * cols + col) * 4 + 3] = Math.min(255, 3 * coverage / (cellWidth * cellHeight));
        }
    }
    return { cols, rows, rgba };
}
