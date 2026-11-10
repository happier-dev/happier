import { PUBLIC_USAGE_PLANET_COPY_EN } from '@happier-dev/protocol/account/publicProfilePresentationCopy';

// Copy for the calendar and planet-family Usage chart bodies (Ninety planets, Streak thread, Weeks, Days on the
// surface, Ringed by streaks, Around the period, Moons, Machines, Projects, Atmosphere).
type Count = { count: string | number };
type CountTotal = { count: string | number; total: string | number };

const block = (copy: {
  levelColumn: string;
  weekColumn: string;
  activeDaysColumn: string;
  shareColumn: string;
  daysColumn: string;
  peakColumn: string;
  kindColumn: string;
  countColumn: string;
  weekdayInitials: string;
  streakBestDays: (p: Count) => string;
  streakNowDays: (p: Count) => string;
  streakOngoingBest: (p: Count) => string;
  daysLit: (p: CountTotal) => string;
  noStreakRings: string;
  partialWeek: (p: { from: string; to: string }) => string;
  moonsCaption: string;
  moonsCaptionDays: string;
  machinesUnavailable: string;
  machinesEmpty: string;
  machineKindUnknown: string;
  projectsEmpty: string;
  atmosphereFirstWeek: string;
  atmosphereCaption: string;
  atmosphereCaptionPeak: (p: Count) => string;
}) => copy;

export const usageChartPlanetFamilyTranslations = {
  en: block(PUBLIC_USAGE_PLANET_COPY_EN),
  es: block({
    levelColumn: 'Actividad',
    weekColumn: 'Semana',
    activeDaysColumn: 'Días activos',
    shareColumn: 'Proporción',
    daysColumn: 'Días',
    peakColumn: 'A la vez',
    kindColumn: 'Máquina',
    countColumn: 'Cuántas',
    weekdayInitials: 'L,M,X,J,V,S,D',
    streakBestDays: ({ count }) => `Mejor · ${count} ${Number(count) === 1 ? 'día' : 'días'}`,
    streakNowDays: ({ count }) => `${count} ${Number(count) === 1 ? 'día' : 'días'} ahora`,
    streakOngoingBest: ({ count }) =>
      `${count} ${Number(count) === 1 ? 'día' : 'días'} · la más larga de este periodo`,
    daysLit: ({ count, total }) => `${count} de ${total} días iluminados`,
    partialWeek: ({ from, to }) => `${from}–${to} · semana parcial`, noStreakRings: 'Ninguna racha de tres días o más en este periodo',
    moonsCaption: 'Cada agente es una luna; su tamaño es su proporción.',
    moonsCaptionDays:
      'Cada agente es una luna; su tamaño es su proporción y la parte iluminada, los días que trabajó.',
    machinesUnavailable:
      'Aún no se registran los tipos de máquina. Aparecerán cuando Happier sepa en qué tipo de máquina se ejecutó cada agente.',
    machinesEmpty: 'Ninguna máquina ejecutó agentes en este periodo.',
    machineKindUnknown: 'Tipo desconocido',
    projectsEmpty: 'Aún no hay proyectos públicos enlazados.',
    atmosphereFirstWeek: 'Semana 1',
    atmosphereCaption:
      'El halo se espesa en las semanas con más agentes a la vez; la semana 1 está arriba.',
    atmosphereCaptionPeak: ({ count }) =>
      `El halo se espesa en las semanas con más agentes a la vez; hasta ${count} a la vez en este periodo.`,
  }),
  de: block({
    levelColumn: 'Aktivität',
    weekColumn: 'Woche',
    activeDaysColumn: 'Aktive Tage',
    shareColumn: 'Anteil',
    daysColumn: 'Tage',
    peakColumn: 'Gleichzeitig',
    kindColumn: 'Rechner',
    countColumn: 'Anzahl',
    weekdayInitials: 'M,D,M,D,F,S,S',
    streakBestDays: ({ count }) => `Bestwert · ${count} ${Number(count) === 1 ? 'Tag' : 'Tage'}`,
    streakNowDays: ({ count }) => `${count} ${Number(count) === 1 ? 'Tag' : 'Tage'} aktuell`,
    streakOngoingBest: ({ count }) =>
      `${count} ${Number(count) === 1 ? 'Tag' : 'Tage'} · deine längste Serie in diesem Zeitraum`,
    daysLit: ({ count, total }) => `${count} von ${total} Tagen beleuchtet`,
    partialWeek: ({ from, to }) => `${from}–${to} · Teilwoche`, noStreakRings: 'Keine Serie von drei oder mehr Tagen in diesem Zeitraum',
    moonsCaption: 'Jeder Agent ist ein Mond; seine Größe ist sein Anteil.',
    moonsCaptionDays:
      'Jeder Agent ist ein Mond; seine Größe ist sein Anteil, der beleuchtete Teil die Tage, an denen er gearbeitet hat.',
    machinesUnavailable:
      'Rechnerarten werden noch nicht erfasst. Sie erscheinen, sobald Happier erkennt, auf welcher Art Rechner jeder Agent lief.',
    machinesEmpty: 'In diesem Zeitraum hat kein Rechner Agenten ausgeführt.',
    machineKindUnknown: 'Unbekannte Art',
    projectsEmpty: 'Noch keine öffentlichen Projekte verlinkt.',
    atmosphereFirstWeek: 'Woche 1',
    atmosphereCaption:
      'Der Halo wird in Wochen mit mehr gleichzeitigen Agenten dichter; Woche 1 ist oben.',
    atmosphereCaptionPeak: ({ count }) =>
      `Der Halo wird in Wochen mit mehr gleichzeitigen Agenten dichter; bis zu ${count} gleichzeitig in diesem Zeitraum.`,
  }),
  fr: block({
    levelColumn: 'Activité',
    weekColumn: 'Semaine',
    activeDaysColumn: 'Jours actifs',
    shareColumn: 'Part',
    daysColumn: 'Jours',
    peakColumn: 'En même temps',
    kindColumn: 'Machine',
    countColumn: 'Combien',
    weekdayInitials: 'L,M,M,J,V,S,D',
    streakBestDays: ({ count }) => `Record · ${count} ${Number(count) === 1 ? 'jour' : 'jours'}`,
    streakNowDays: ({ count }) => `${count} ${Number(count) === 1 ? 'jour' : 'jours'} en cours`,
    streakOngoingBest: ({ count }) =>
      `${count} ${Number(count) === 1 ? 'jour' : 'jours'} · votre plus longue série sur cette période`,
    daysLit: ({ count, total }) => `${count} jours éclairés sur ${total}`,
    partialWeek: ({ from, to }) => `${from}–${to} · semaine partielle`, noStreakRings: 'Aucune série de trois jours ou plus sur cette période',
    moonsCaption: 'Chaque agent est une lune ; sa taille est sa part.',
    moonsCaptionDays:
      'Chaque agent est une lune ; sa taille est sa part, la partie éclairée le nombre de jours où il a travaillé.',
    machinesUnavailable:
      'Les types de machine ne sont pas encore enregistrés. Ils apparaîtront quand Happier saura sur quel type de machine chaque agent a tourné.',
    machinesEmpty: 'Aucune machine n’a exécuté d’agents sur cette période.',
    machineKindUnknown: 'Type inconnu',
    projectsEmpty: 'Aucun projet public lié pour l’instant.',
    atmosphereFirstWeek: 'Semaine 1',
    atmosphereCaption:
      'Le halo s’épaissit les semaines où plus d’agents travaillent en même temps ; la semaine 1 est en haut.',
    atmosphereCaptionPeak: ({ count }) =>
      `Le halo s’épaissit les semaines où plus d’agents travaillent en même temps ; jusqu’à ${count} en même temps sur cette période.`,
  }),
  it: block({
    levelColumn: 'Attività',
    weekColumn: 'Settimana',
    activeDaysColumn: 'Giorni attivi',
    shareColumn: 'Quota',
    daysColumn: 'Giorni',
    peakColumn: 'In contemporanea',
    kindColumn: 'Macchina',
    countColumn: 'Quante',
    weekdayInitials: 'L,M,M,G,V,S,D',
    streakBestDays: ({ count }) => `Record · ${count} ${Number(count) === 1 ? 'giorno' : 'giorni'}`,
    streakNowDays: ({ count }) => `${count} ${Number(count) === 1 ? 'giorno' : 'giorni'} ora`,
    streakOngoingBest: ({ count }) =>
      `${count} ${Number(count) === 1 ? 'giorno' : 'giorni'} · la tua serie più lunga in questo periodo`,
    daysLit: ({ count, total }) => `${count} giorni illuminati su ${total}`,
    partialWeek: ({ from, to }) => `${from}–${to} · settimana parziale`, noStreakRings: 'Nessuna serie di tre giorni o più in questo periodo',
    moonsCaption: 'Ogni agente è una luna; la sua dimensione è la sua quota.',
    moonsCaptionDays:
      'Ogni agente è una luna; la dimensione è la sua quota, la parte illuminata i giorni in cui ha lavorato.',
    machinesUnavailable:
      'I tipi di macchina non sono ancora registrati. Appariranno quando Happier saprà su quale tipo di macchina è stato eseguito ogni agente.',
    machinesEmpty: 'Nessuna macchina ha eseguito agenti in questo periodo.',
    machineKindUnknown: 'Tipo sconosciuto',
    projectsEmpty: 'Nessun progetto pubblico collegato per ora.',
    atmosphereFirstWeek: 'Settimana 1',
    atmosphereCaption:
      'L’alone si infittisce nelle settimane con più agenti in contemporanea; la settimana 1 è in alto.',
    atmosphereCaptionPeak: ({ count }) =>
      `L’alone si infittisce nelle settimane con più agenti in contemporanea; fino a ${count} in contemporanea in questo periodo.`,
  }),
  pt: block({
    levelColumn: 'Atividade',
    weekColumn: 'Semana',
    activeDaysColumn: 'Dias ativos',
    shareColumn: 'Parcela',
    daysColumn: 'Dias',
    peakColumn: 'Ao mesmo tempo',
    kindColumn: 'Máquina',
    countColumn: 'Quantas',
    weekdayInitials: 'S,T,Q,Q,S,S,D',
    streakBestDays: ({ count }) => `Recorde · ${count} ${Number(count) === 1 ? 'dia' : 'dias'}`,
    streakNowDays: ({ count }) => `${count} ${Number(count) === 1 ? 'dia' : 'dias'} agora`,
    streakOngoingBest: ({ count }) =>
      `${count} ${Number(count) === 1 ? 'dia' : 'dias'} · sua maior sequência neste período`,
    daysLit: ({ count, total }) => `${count} de ${total} dias iluminados`,
    partialWeek: ({ from, to }) => `${from}–${to} · semana parcial`, noStreakRings: 'Nenhuma sequência de três dias ou mais neste período',
    moonsCaption: 'Cada agente é uma lua; o tamanho é a sua parcela.',
    moonsCaptionDays:
      'Cada agente é uma lua; o tamanho é a sua parcela e a parte iluminada, os dias em que trabalhou.',
    machinesUnavailable:
      'Os tipos de máquina ainda não são registrados. Eles aparecem quando o Happier souber em que tipo de máquina cada agente rodou.',
    machinesEmpty: 'Nenhuma máquina executou agentes neste período.',
    machineKindUnknown: 'Tipo desconhecido',
    projectsEmpty: 'Nenhum projeto público vinculado ainda.',
    atmosphereFirstWeek: 'Semana 1',
    atmosphereCaption:
      'O halo fica mais denso nas semanas com mais agentes ao mesmo tempo; a semana 1 fica no topo.',
    atmosphereCaptionPeak: ({ count }) =>
      `O halo fica mais denso nas semanas com mais agentes ao mesmo tempo; até ${count} ao mesmo tempo neste período.`,
  }),
  ru: block({
    levelColumn: 'Активность',
    weekColumn: 'Неделя',
    activeDaysColumn: 'Активные дни',
    shareColumn: 'Доля',
    daysColumn: 'Дни',
    peakColumn: 'Одновременно',
    kindColumn: 'Компьютер',
    countColumn: 'Сколько',
    weekdayInitials: 'П,В,С,Ч,П,С,В',
    streakBestDays: ({ count }) => `Лучшая · ${count} дн.`,
    streakNowDays: ({ count }) => `${count} дн. сейчас`,
    streakOngoingBest: ({ count }) =>
      `${count} дн. · самая длинная серия за период`,
    daysLit: ({ count, total }) => `Освещено ${count} из ${total} дней`,
    partialWeek: ({ from, to }) => `${from}–${to} · неполная неделя`, noStreakRings: 'За этот период нет серий из трёх дней и более',
    moonsCaption: 'Каждый агент — луна; её размер — его доля.',
    moonsCaptionDays:
      'Каждый агент — луна; её размер — его доля, освещённая часть — сколько дней он работал.',
    machinesUnavailable:
      'Типы компьютеров пока не записываются. Они появятся, когда Happier сможет определить, на каком типе компьютера работал каждый агент.',
    machinesEmpty: 'За этот период ни один компьютер не запускал агентов.',
    machineKindUnknown: 'Неизвестный тип',
    projectsEmpty: 'Публичных проектов пока нет.',
    atmosphereFirstWeek: 'Неделя 1',
    atmosphereCaption:
      'Ореол гуще в недели, когда одновременно работало больше агентов; неделя 1 вверху.',
    atmosphereCaptionPeak: ({ count }) =>
      `Ореол гуще в недели, когда одновременно работало больше агентов; до ${count} одновременно за период.`,
  }),
  ja: block({
    levelColumn: '活動量',
    weekColumn: '週',
    activeDaysColumn: '活動日',
    shareColumn: '割合',
    daysColumn: '日数',
    peakColumn: '同時実行',
    kindColumn: 'マシン',
    countColumn: '台数',
    weekdayInitials: '月,火,水,木,金,土,日',
    streakBestDays: ({ count }) => `最長 · ${count}日`,
    streakNowDays: ({ count }) => `現在${count}日`,
    streakOngoingBest: ({ count }) => `${count}日 · この期間で最長`,
    daysLit: ({ count, total }) => `${total}日中${count}日が点灯`,
    partialWeek: ({ from, to }) => `${from}–${to} · 一部の週`, noStreakRings: 'この期間に3日以上の連続はありません',
    moonsCaption: '各エージェントは月です。大きさは割合を表します。',
    moonsCaptionDays:
      '各エージェントは月です。大きさは割合、明るい部分は稼働した日数を表します。',
    machinesUnavailable:
      'マシンの種類はまだ記録されていません。各エージェントが動いたマシンの種類を Happier が判別できると表示されます。',
    machinesEmpty: 'この期間にエージェントを実行したマシンはありません。',
    machineKindUnknown: '不明な種類',
    projectsEmpty: '公開プロジェクトはまだリンクされていません。',
    atmosphereFirstWeek: '第1週',
    atmosphereCaption:
      '同時に動いたエージェントが多い週ほど光輪が濃くなります。第1週が上です。',
    atmosphereCaptionPeak: ({ count }) =>
      `同時に動いたエージェントが多い週ほど光輪が濃くなります。この期間の最大は同時${count}件です。`,
  }),
  'zh-Hans': block({
    levelColumn: '活跃度',
    weekColumn: '周',
    activeDaysColumn: '活跃天数',
    shareColumn: '占比',
    daysColumn: '天数',
    peakColumn: '同时运行',
    kindColumn: '机器',
    countColumn: '数量',
    weekdayInitials: '一,二,三,四,五,六,日',
    streakBestDays: ({ count }) => `最长 · ${count} 天`,
    streakNowDays: ({ count }) => `当前 ${count} 天`,
    streakOngoingBest: ({ count }) => `${count} 天 · 本期最长`,
    daysLit: ({ count, total }) => `${total} 天中有 ${count} 天点亮`,
    partialWeek: ({ from, to }) => `${from}–${to} · 部分周`, noStreakRings: '本期没有连续三天或以上的记录',
    moonsCaption: '每个智能体是一颗月亮，大小代表占比。',
    moonsCaptionDays:
      '每个智能体是一颗月亮，大小代表占比，亮面代表工作的天数。',
    machinesUnavailable:
      '尚未记录机器类型。Happier 能识别每个智能体运行的机器类型后会在此显示。',
    machinesEmpty: '本期没有机器运行智能体。',
    machineKindUnknown: '未知类型',
    projectsEmpty: '尚未关联公开项目。',
    atmosphereFirstWeek: '第 1 周',
    atmosphereCaption: '同时运行的智能体越多的周，光晕越浓；第 1 周在顶部。',
    atmosphereCaptionPeak: ({ count }) =>
      `同时运行的智能体越多的周，光晕越浓；本期最多同时 ${count} 个。`,
  }),
  'zh-Hant': block({
    levelColumn: '活躍度',
    weekColumn: '週',
    activeDaysColumn: '活躍天數',
    shareColumn: '占比',
    daysColumn: '天數',
    peakColumn: '同時執行',
    kindColumn: '機器',
    countColumn: '數量',
    weekdayInitials: '一,二,三,四,五,六,日',
    streakBestDays: ({ count }) => `最長 · ${count} 天`,
    streakNowDays: ({ count }) => `目前 ${count} 天`,
    streakOngoingBest: ({ count }) => `${count} 天 · 本期最長`,
    daysLit: ({ count, total }) => `${total} 天中有 ${count} 天點亮`,
    partialWeek: ({ from, to }) => `${from}–${to} · 部分週`, noStreakRings: '本期沒有連續三天或以上的紀錄',
    moonsCaption: '每個智慧體是一顆月亮，大小代表占比。',
    moonsCaptionDays:
      '每個智慧體是一顆月亮，大小代表占比，亮面代表工作的天數。',
    machinesUnavailable:
      '尚未記錄機器類型。Happier 能辨識每個智慧體執行的機器類型後會在此顯示。',
    machinesEmpty: '本期沒有機器執行智慧體。',
    machineKindUnknown: '未知類型',
    projectsEmpty: '尚未連結公開專案。',
    atmosphereFirstWeek: '第 1 週',
    atmosphereCaption: '同時執行的智慧體越多的週，光暈越濃；第 1 週在頂部。',
    atmosphereCaptionPeak: ({ count }) =>
      `同時執行的智慧體越多的週，光暈越濃；本期最多同時 ${count} 個。`,
  }),
  pl: block({
    levelColumn: 'Aktywność',
    weekColumn: 'Tydzień',
    activeDaysColumn: 'Aktywne dni',
    shareColumn: 'Udział',
    daysColumn: 'Dni',
    peakColumn: 'Jednocześnie',
    kindColumn: 'Maszyna',
    countColumn: 'Ile',
    weekdayInitials: 'P,W,Ś,C,P,S,N',
    streakBestDays: ({ count }) => `Najlepsza · ${count} ${Number(count) === 1 ? 'dzień' : 'dni'}`,
    streakNowDays: ({ count }) => `${count} ${Number(count) === 1 ? 'dzień' : 'dni'} teraz`,
    streakOngoingBest: ({ count }) =>
      `${count} ${Number(count) === 1 ? 'dzień' : 'dni'} · najdłuższa seria w tym okresie`,
    daysLit: ({ count, total }) => `${count} z ${total} dni rozświetlonych`,
    partialWeek: ({ from, to }) => `${from}–${to} · niepełny tydzień`, noStreakRings: 'Brak serii trzech lub więcej dni w tym okresie',
    moonsCaption: 'Każdy agent to księżyc; jego wielkość to udział.',
    moonsCaptionDays:
      'Każdy agent to księżyc; wielkość to udział, oświetlona część to dni, w których pracował.',
    machinesUnavailable:
      'Rodzaje maszyn nie są jeszcze zapisywane. Pojawią się, gdy Happier rozpozna, na jakim rodzaju maszyny działał każdy agent.',
    machinesEmpty: 'W tym okresie żadna maszyna nie uruchamiała agentów.',
    machineKindUnknown: 'Nieznany rodzaj',
    projectsEmpty: 'Nie połączono jeszcze publicznych projektów.',
    atmosphereFirstWeek: 'Tydzień 1',
    atmosphereCaption:
      'Poświata gęstnieje w tygodniach z większą liczbą agentów naraz; tydzień 1 jest na górze.',
    atmosphereCaptionPeak: ({ count }) =>
      `Poświata gęstnieje w tygodniach z większą liczbą agentów naraz; do ${count} naraz w tym okresie.`,
  }),
  ca: block({
    levelColumn: 'Activitat',
    weekColumn: 'Setmana',
    activeDaysColumn: 'Dies actius',
    shareColumn: 'Proporció',
    daysColumn: 'Dies',
    peakColumn: 'Alhora',
    kindColumn: 'Màquina',
    countColumn: 'Quantes',
    weekdayInitials: 'Dl,Dt,Dc,Dj,Dv,Ds,Dg',
    streakBestDays: ({ count }) => `Millor · ${count} ${Number(count) === 1 ? 'dia' : 'dies'}`,
    streakNowDays: ({ count }) => `${count} ${Number(count) === 1 ? 'dia' : 'dies'} ara`,
    streakOngoingBest: ({ count }) =>
      `${count} ${Number(count) === 1 ? 'dia' : 'dies'} · la ratxa més llarga d’aquest període`,
    daysLit: ({ count, total }) => `${count} de ${total} dies il·luminats`,
    partialWeek: ({ from, to }) => `${from}–${to} · setmana parcial`, noStreakRings: 'Cap ratxa de tres dies o més en aquest període',
    moonsCaption: 'Cada agent és una lluna; la mida és la seva proporció.',
    moonsCaptionDays:
      'Cada agent és una lluna; la mida és la seva proporció i la part il·luminada, els dies que va treballar.',
    machinesUnavailable:
      'Encara no es registren els tipus de màquina. Apareixeran quan Happier sàpiga en quin tipus de màquina s’ha executat cada agent.',
    machinesEmpty: 'Cap màquina no ha executat agents en aquest període.',
    machineKindUnknown: 'Tipus desconegut',
    projectsEmpty: 'Encara no hi ha projectes públics enllaçats.',
    atmosphereFirstWeek: 'Setmana 1',
    atmosphereCaption:
      'L’halo s’espesseix les setmanes amb més agents alhora; la setmana 1 és a dalt.',
    atmosphereCaptionPeak: ({ count }) =>
      `L’halo s’espesseix les setmanes amb més agents alhora; fins a ${count} alhora en aquest període.`,
  }),
} as const;
