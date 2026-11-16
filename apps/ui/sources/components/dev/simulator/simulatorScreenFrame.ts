/**
 * Dev-only stream-frame fixture: a phone app's home screen at a phone's aspect (390 × 844 points),
 * so the device viewer's stage is judged with the picture it really letterboxes.
 */
const SCREEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">
<rect width="390" height="844" fill="#F6F4EF"/>
<text x="32" y="34" font-family="-apple-system,Inter,sans-serif" font-size="15" font-weight="600" fill="#1C1B19">9:41</text>
<rect x="318" y="24" width="24" height="12" rx="3" fill="none" stroke="#1C1B19" stroke-width="1.4"/>
<rect x="320.5" y="26.5" width="17" height="7" rx="1.5" fill="#1C1B19"/>
<circle cx="300" cy="30" r="5" fill="#1C1B19"/>
<rect x="24" y="76" width="34" height="34" rx="9" fill="#5B3DF5"/>
<text x="70" y="99" font-family="-apple-system,Inter,sans-serif" font-size="19" font-weight="700" fill="#1C1B19">Lumen</text>
<circle cx="350" cy="93" r="17" fill="#E4DFD5"/>
<text x="341" y="99" font-family="-apple-system,Inter,sans-serif" font-size="15" font-weight="600" fill="#5C574E">AR</text>
<text x="24" y="156" font-family="-apple-system,Inter,sans-serif" font-size="28" font-weight="700" fill="#1C1B19">Good morning, Ana</text>
<text x="24" y="182" font-family="-apple-system,Inter,sans-serif" font-size="15" fill="#6F6A60">3 tasks due today</text>
<rect x="24" y="206" width="342" height="128" rx="18" fill="#5B3DF5"/>
<text x="44" y="242" font-family="-apple-system,Inter,sans-serif" font-size="14" fill="#D9D2FF">This week</text>
<text x="44" y="282" font-family="-apple-system,Inter,sans-serif" font-size="34" font-weight="700" fill="#FFFFFF">12 of 18</text>
<text x="44" y="310" font-family="-apple-system,Inter,sans-serif" font-size="14" fill="#D9D2FF">tasks finished</text>
<rect x="44" y="318" width="302" height="4" rx="2" fill="#7C64F7"/>
<rect x="44" y="318" width="201" height="4" rx="2" fill="#FFFFFF"/>
<text x="24" y="380" font-family="-apple-system,Inter,sans-serif" font-size="17" font-weight="600" fill="#1C1B19">Today</text>
<g font-family="-apple-system,Inter,sans-serif">
<rect x="24" y="398" width="342" height="70" rx="14" fill="#FFFFFF"/>
<circle cx="52" cy="433" r="10" fill="none" stroke="#5B3DF5" stroke-width="2"/>
<text x="76" y="429" font-size="16" font-weight="600" fill="#1C1B19">Review onboarding copy</text>
<text x="76" y="450" font-size="13" fill="#8A8478">Design · 10:00</text>
<rect x="24" y="478" width="342" height="70" rx="14" fill="#FFFFFF"/>
<circle cx="52" cy="513" r="10" fill="none" stroke="#5B3DF5" stroke-width="2"/>
<text x="76" y="509" font-size="16" font-weight="600" fill="#1C1B19">Ship push permissions prompt</text>
<text x="76" y="530" font-size="13" fill="#8A8478">Mobile · 13:30</text>
<rect x="24" y="558" width="342" height="70" rx="14" fill="#FFFFFF"/>
<circle cx="52" cy="593" r="10" fill="#5B3DF5"/>
<path d="M47 593 l4 4 l7 -8" fill="none" stroke="#FFFFFF" stroke-width="2"/>
<text x="76" y="589" font-size="16" font-weight="600" fill="#8A8478" text-decoration="line-through">Standup notes</text>
<text x="76" y="610" font-size="13" fill="#8A8478">Team · 09:15</text>
</g>
<rect x="0" y="752" width="390" height="92" fill="#FFFFFF"/>
<rect x="0" y="752" width="390" height="1" fill="#E7E2D8"/>
<g font-family="-apple-system,Inter,sans-serif" font-size="11" text-anchor="middle">
<rect x="52" y="768" width="22" height="20" rx="5" fill="#5B3DF5"/><text x="63" y="804" fill="#5B3DF5">Home</text>
<rect x="152" y="768" width="22" height="20" rx="5" fill="none" stroke="#8A8478" stroke-width="1.6"/><text x="163" y="804" fill="#8A8478">Tasks</text>
<circle cx="263" cy="778" r="10" fill="none" stroke="#8A8478" stroke-width="1.6"/><text x="263" y="804" fill="#8A8478">Inbox</text>
<circle cx="340" cy="778" r="10" fill="none" stroke="#8A8478" stroke-width="1.6"/><text x="340" y="804" fill="#8A8478">Me</text>
</g>
<rect x="128" y="826" width="134" height="5" rx="2.5" fill="#1C1B19"/>
</svg>`;

export const SIMULATOR_PHONE_SCREEN_FRAME = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SCREEN_SVG)}`;
