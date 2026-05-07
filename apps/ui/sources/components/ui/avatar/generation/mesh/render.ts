import type {
    MeshGradientAvatarModel,
    MeshGradientColorField,
    MeshGradientDepthField,
    MeshGradientWaveField,
} from '@/components/ui/avatar/meshGradient/meshGradientTypes';

function stripAlpha(color: string): string {
    const match = color.match(/^rgba\((\d+), (\d+), (\d+), (0(?:\.\d+)?|1(?:\.0+)?)\)$/);
    return match ? `rgb(${match[1]}, ${match[2]}, ${match[3]})` : color;
}

function readAlpha(color: string, fallback: number): number {
    const match = color.match(/^rgba\(\d+, \d+, \d+, (0(?:\.\d+)?|1(?:\.0+)?)\)$/);
    return match ? Number(match[1]) : fallback;
}

function lightenColor(color: string, amount: number): string {
    const match = stripAlpha(color).match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    if (!match) return stripAlpha(color);
    const ratio = Math.max(0, Math.min(1, amount));
    const channels = [Number(match[1]), Number(match[2]), Number(match[3])]
        .map((channel) => Math.round(channel + ((255 - channel) * ratio)));
    return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

function stop(offset: number, color: string, opacity: number): string {
    return `<stop offset="${offset}" stop-color="${stripAlpha(color)}" stop-opacity="${Math.max(0, Math.min(1, opacity))}"/>`;
}

function depthGradient(id: string, field: MeshGradientDepthField): string {
    return [
        `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${field.cx}" cy="${field.cy}" r="${field.radius}">`,
        stop(0, field.color, readAlpha(field.color, 0.24)),
        stop(0.42, field.color, readAlpha(field.color, 0.24)),
        stop(1, field.color, 0),
        '</radialGradient>',
    ].join('');
}

function colorGradient(id: string, field: MeshGradientColorField): string {
    return [
        `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${field.cx}" cy="${field.cy}" r="${field.radius}">`,
        stop(0, field.color, field.opacity),
        stop(0.34, field.color, field.opacity * 0.82),
        stop(1, field.color, 0),
        '</radialGradient>',
    ].join('');
}

function waveGradient(id: string, field: MeshGradientWaveField): string {
    return [
        `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">`,
        stop(0, field.color, 0),
        stop(0.5, field.color, field.opacity),
        stop(1, field.color, 0),
        '</linearGradient>',
    ].join('');
}

function bandGradient(id: string, field: MeshGradientColorField): string {
    const outerRidgeColor = lightenColor(field.color, 0.06);
    const midRidgeColor = lightenColor(field.color, 0.12);
    const peakRidgeColor = lightenColor(field.color, 0.18);
    return [
        `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">`,
        stop(0, field.color, 0),
        stop(0.12, field.color, field.opacity * 0.04),
        stop(0.2, field.color, field.opacity * 0.16),
        stop(0.26, outerRidgeColor, field.opacity * 0.32),
        stop(0.38, midRidgeColor, field.opacity * 0.48),
        stop(0.5, peakRidgeColor, field.opacity * 0.56),
        stop(0.62, midRidgeColor, field.opacity * 0.48),
        stop(0.74, outerRidgeColor, field.opacity * 0.32),
        stop(0.8, field.color, field.opacity * 0.16),
        stop(0.88, field.color, field.opacity * 0.04),
        stop(1, field.color, 0),
        '</linearGradient>',
    ].join('');
}

function renderRows(model: MeshGradientAvatarModel, size: number): string {
    const fields = model.colorFields.slice(0, 5);
    return [
        '<g id="avatar-pattern-rows" opacity="0.92">',
        ...fields.map((field, index) => {
            const y = ((field.cy / size) * size) - (size * 0.14);
            const height = size * (0.22 + ((index % 2) * 0.06));
            return `<rect x="${-size * 0.08}" y="${y}" width="${size * 1.16}" height="${height}" fill="url(#band-${index})" transform="rotate(${index % 2 === 0 ? -3 : 4} ${size / 2} ${size / 2})"/>`;
        }),
        '</g>',
    ].join('');
}

function renderColumns(model: MeshGradientAvatarModel, size: number): string {
    const fields = model.colorFields.slice(0, 5);
    return [
        '<g id="avatar-pattern-columns" opacity="0.92">',
        ...fields.map((field, index) => {
            const x = ((field.cx / size) * size) - (size * 0.14);
            const width = size * (0.22 + ((index % 2) * 0.06));
            return `<rect x="${x}" y="${-size * 0.08}" width="${width}" height="${size * 1.16}" fill="url(#band-${index})" transform="rotate(${index % 2 === 0 ? 3 : -4} ${size / 2} ${size / 2})"/>`;
        }),
        '</g>',
    ].join('');
}

function renderDiagonal(model: MeshGradientAvatarModel, size: number): string {
    const rotation = 18;
    const fields = model.colorFields.slice(0, 5);
    return [
        '<g id="avatar-pattern-diagonal" opacity="0.92">',
        ...fields.map((field, index) => {
            const x = ((field.cx / size) * size) - (size * 0.2);
            const width = size * (0.22 + ((index % 2) * 0.06));
            return `<rect x="${x}" y="${-size * 0.46}" width="${width}" height="${size * 1.92}" fill="url(#band-${index})" transform="rotate(${rotation} ${size / 2} ${size / 2})"/>`;
        }),
        '</g>',
    ].join('');
}

function renderOval(model: MeshGradientAvatarModel, size: number): string {
    const fields = model.colorFields.slice(0, 4);
    return [
        '<g id="avatar-pattern-oval" opacity="0.9">',
        ...fields.map((field, index) => {
            const rx = size * (0.32 + ((index % 2) * 0.08));
            const ry = size * (0.22 + ((index % 3) * 0.04));
            return `<ellipse cx="${field.cx}" cy="${field.cy}" rx="${rx}" ry="${ry}" fill="url(#field-${index})" transform="rotate(${(index * 23) - 28} ${field.cx} ${field.cy})"/>`;
        }),
        '</g>',
    ].join('');
}

function renderWaves(model: MeshGradientAvatarModel, size: number): string {
    return [
        '<g id="avatar-pattern-waves" opacity="0.84">',
        ...model.waveFields.map((field, index) => {
            const y = field.y + (index * size * 0.16);
            return `<path d="M ${-size * 0.08} ${y} C ${size * 0.18} ${y - (size * 0.14)}, ${size * 0.36} ${y + (size * 0.18)}, ${size * 0.62} ${y} S ${size * 1.04} ${y - (size * 0.04)}, ${size * 1.16} ${y + (size * 0.08)}" stroke="url(#wave-${index})" stroke-width="${Math.max(10, field.height)}" stroke-linecap="round" fill="none" transform="rotate(${field.rotation * 0.4} ${size / 2} ${size / 2})"/>`;
        }),
        '</g>',
    ].join('');
}

function renderSoftNoise(model: MeshGradientAvatarModel, size: number): string {
    return [
        '<g id="avatar-pattern-softNoise" opacity="0.92">',
        ...model.colorFields.slice(0, 6).map((field, index) => {
            const rx = field.radius * (0.44 + ((index % 3) * 0.05));
            const ry = field.radius * (0.32 + ((index % 2) * 0.08));
            return `<ellipse cx="${field.cx}" cy="${field.cy}" rx="${rx}" ry="${ry}" fill="url(#field-${index})" transform="rotate(${(index * 31) % 180} ${field.cx} ${field.cy})"/>`;
        }),
        '</g>',
    ].join('');
}

function renderPattern(model: MeshGradientAvatarModel, size: number): string {
    if (model.patternVariant === 'rows') return renderRows(model, size);
    if (model.patternVariant === 'columns') return renderColumns(model, size);
    if (model.patternVariant === 'diagonal') return renderDiagonal(model, size);
    if (model.patternVariant === 'oval') return renderOval(model, size);
    if (model.patternVariant === 'waves') return renderWaves(model, size);
    if (model.patternVariant === 'softNoise') return renderSoftNoise(model, size);
    return '<g id="avatar-pattern-organic"/>';
}

function renderGrain(model: MeshGradientAvatarModel, size: number): string {
    const fields = model.colorFields.length > 0 ? model.colorFields : [];
    const dots: string[] = [];
    for (let index = 0; index < 28; index += 1) {
        const field = fields[index % fields.length];
        if (!field) break;
        const x = (field.cx * (index + 3) + field.cy * 0.7 + (index * 17)) % size;
        const y = (field.cy * (index + 5) + field.cx * 0.4 + (index * 11)) % size;
        const opacity = 0.025 + ((index % 5) * 0.006);
        const radius = 0.32 + ((index % 4) * 0.12);
        const color = index % 2 === 0 ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)';
        dots.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${color}" opacity="${opacity}"/>`);
    }
    return `<g id="avatar-grain">${dots.join('')}</g>`;
}

export function renderMeshGradientSvg(model: MeshGradientAvatarModel, size: number): string {
    const colorDefs = model.colorFields.map((field, index) => colorGradient(`field-${index}`, field)).join('');
    const waveDefs = model.waveFields.map((field, index) => waveGradient(`wave-${index}`, field)).join('');
    const bandDefs = model.colorFields.slice(0, 5).map((field, index) => bandGradient(`band-${index}`, field)).join('');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
        '<defs>',
        `<linearGradient id="base" x1="${model.baseGradient.startX}" y1="${model.baseGradient.startY}" x2="${model.baseGradient.endX}" y2="${model.baseGradient.endY}" gradientUnits="userSpaceOnUse">`,
        stop(0, model.baseGradient.startColor, 1),
        stop(1, model.baseGradient.endColor, 1),
        '</linearGradient>',
        depthGradient('depth', model.depthField),
        depthGradient('highlight', model.highlightField),
        colorDefs,
        waveDefs,
        bandDefs,
        '</defs>',
        '<rect width="100%" height="100%" fill="url(#base)"/>',
        '<rect width="100%" height="100%" fill="url(#depth)" opacity="0.82"/>',
        '<rect width="100%" height="100%" fill="url(#highlight)" opacity="0.78"/>',
        '<g id="avatar-fields">',
        ...model.colorFields.map((_field, index) => `<rect width="100%" height="100%" fill="url(#field-${index})"/>`),
        '</g>',
        renderPattern(model, size),
        renderGrain(model, size),
        '</svg>',
    ].join('');
}
