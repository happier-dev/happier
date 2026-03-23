type FeatureExtractionTensorLike = {
  tolist?: () => any;
  data?: unknown;
  dims?: unknown;
};

function toFloat32ArrayRow(value: unknown): Float32Array | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = new Float32Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const next = Number(value[index]);
    out[index] = Number.isFinite(next) ? next : 0;
  }
  return out;
}

function splitBatchFromFlat(data: Float32Array, batch: number, dims: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let index = 0; index < batch; index += 1) {
    const start = index * dims;
    out.push(new Float32Array(data.slice(start, start + dims)));
  }
  return out;
}

export async function tensorToVectors(
  tensor: FeatureExtractionTensorLike,
  expectedBatch: number,
): Promise<Float32Array[]> {
  const tolist = typeof tensor?.tolist === 'function' ? () => tensor.tolist?.() : null;
  if (tolist) {
    const list = await tolist();
    if (Array.isArray(list) && Array.isArray(list[0])) {
      const rows: Float32Array[] = [];
      for (const rowValue of list) {
        const row = toFloat32ArrayRow(rowValue);
        if (row) rows.push(row);
      }
      return expectedBatch === 1 ? rows.slice(0, 1) : rows;
    }
  }

  const dimsRaw = tensor?.dims;
  const dims = Array.isArray(dimsRaw) ? dimsRaw.map((value) => Number(value)) : null;
  const data = tensor?.data instanceof Float32Array ? tensor.data : null;
  if (!dims || dims.length < 2 || !data) return [];

  const batch = Number.isFinite(dims[0] as number) ? Math.trunc(dims[0] as number) : 0;
  const width = Number.isFinite(dims[1] as number) ? Math.trunc(dims[1] as number) : 0;
  if (batch <= 0 || width <= 0) return [];
  if (batch !== expectedBatch) return [];
  if (data.length !== batch * width) return [];
  return splitBatchFromFlat(data, batch, width);
}
